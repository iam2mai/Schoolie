// The website: a small password-protected server for asking questions about
// school letters, adding letters, and subscribing to their dates.
//
//   npm start      (needs APP_PASSWORD; see README "Website")
//
// No framework: node:http plus the same code the CLI uses (src/app.ts).
// The LLM API key never leaves the server.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hasApiKey } from "./llm.ts";
import { toICS } from "./ics.ts";
import {
  ROOT, paths, ask, sync, upcoming, cachedEvents, listLetters, saveLetter, deleteLetter, calendarName,
  UserError, type Paths,
} from "./app.ts";

export interface ServerOptions {
  paths: Paths;
  password: string;
  sessionSecret: string;
  calendarToken?: string; // enables GET /calendar/<token>.ics for phone subscriptions
  trustProxy?: boolean;   // behind a host's proxy: read client IP and https from X-Forwarded-*
  log?: (msg: string) => void;
}

const SESSION_DAYS = 30;
const MAX_BODY = 256 * 1024;
const MAX_QUESTION = 1000;
const LOGIN_LIMIT = { attempts: 10, windowMs: 15 * 60_000 };

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

export function createAppServer(opts: ServerOptions): Server {
  const log = opts.log ?? console.log;
  const p = opts.paths;
  const failedLogins = new Map<string, { count: number; resetAt: number }>();

  // --- sessions: a signed expiry time in an HttpOnly cookie ---------------
  const sign = (value: string) => createHmac("sha256", opts.sessionSecret).update(`session.${value}`).digest("base64url");

  function newSession(): string {
    const exp = String(Date.now() + SESSION_DAYS * 86_400_000);
    return `${exp}.${sign(exp)}`;
  }

  function isAuthed(req: IncomingMessage): boolean {
    const token = cookies(req).sid;
    if (!token) return false;
    const [exp, sig] = token.split(".");
    return Boolean(exp && sig) && safeEqual(sig, sign(exp)) && Number(exp) > Date.now();
  }

  const isHttps = (req: IncomingMessage) =>
    (req.socket as any).encrypted === true || (opts.trustProxy === true && req.headers["x-forwarded-proto"] === "https");

  // X-Forwarded-For is a list the proxy appends the real client IP to the end
  // of. Take the LAST entry: a client can forge earlier ones (defeating the
  // login rate limit), but can't push anything past what our own proxy adds.
  const clientIp = (req: IncomingMessage) => {
    if (opts.trustProxy) {
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress || "unknown";
  };

  function sessionCookie(req: IncomingMessage, value: string, maxAge: number): string {
    return `sid=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
  }

  // --- routes ---------------------------------------------------------------
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && STATIC[path]) {
      const { file, type } = STATIC[path];
      return send(res, 200, readFileSync(join(ROOT, "public", file)), type);
    }

    // Calendar subscription: authenticated by the secret in the URL, because
    // calendar apps can't log in.
    const cal = path.match(/^\/calendar\/([^/]+)\.ics$/);
    if (method === "GET" && cal) {
      if (!opts.calendarToken || !safeEqual(cal[1], opts.calendarToken)) return json(res, 404, { error: "Not found." });
      return send(res, 200, toICS(cachedEvents(p), { name: calendarName() }), "text/calendar; charset=utf-8");
    }

    if (!path.startsWith("/api/")) return json(res, 404, { error: "Not found." });

    // Cross-site requests are refused: the cookie is SameSite=Strict, writes
    // must be JSON, and a foreign Origin header is rejected outright.
    const origin = req.headers.origin;
    if (origin && hostOf(origin) !== req.headers.host) return json(res, 403, { error: "Cross-site request refused." });
    if (method !== "GET" && method !== "DELETE" && !String(req.headers["content-type"]).startsWith("application/json")) {
      return json(res, 415, { error: "Send JSON." });
    }

    if (method === "POST" && path === "/api/login") {
      const ip = clientIp(req);
      const now = Date.now();
      const entry = failedLogins.get(ip);
      if (entry && entry.resetAt > now && entry.count >= LOGIN_LIMIT.attempts) {
        return json(res, 429, { error: "Too many attempts. Try again in a few minutes." });
      }
      const { password } = await body(req);
      if (typeof password !== "string" || !safeEqual(password, opts.password)) {
        const fresh = !entry || entry.resetAt <= now;
        failedLogins.set(ip, { count: fresh ? 1 : entry.count + 1, resetAt: fresh ? now + LOGIN_LIMIT.windowMs : entry.resetAt });
        return json(res, 401, { error: "Wrong password." });
      }
      failedLogins.delete(ip);
      res.setHeader("set-cookie", sessionCookie(req, newSession(), SESSION_DAYS * 86_400));
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/logout") {
      res.setHeader("set-cookie", sessionCookie(req, "", 0));
      return json(res, 200, { ok: true });
    }

    const authed = isAuthed(req);
    if (method === "GET" && path === "/api/me") {
      return json(res, 200, authed
        ? { authenticated: true, llmConfigured: hasApiKey(), calendarPath: opts.calendarToken ? `/calendar/${opts.calendarToken}.ics` : null }
        : { authenticated: false });
    }
    if (!authed) return json(res, 401, { error: "Please log in." });

    if (method === "POST" && path === "/api/ask") {
      const { question } = await body(req);
      if (typeof question !== "string" || !question.trim()) throw new UserError("Type a question.");
      if (question.length > MAX_QUESTION) throw new UserError(`Questions are limited to ${MAX_QUESTION} characters.`);
      return json(res, 200, await ask(p, question.trim()));
    }

    if (method === "GET" && path === "/api/letters") return json(res, 200, { letters: listLetters(p) });

    if (method === "POST" && path === "/api/letters") {
      const { text, sentDate } = await body(req);
      if (typeof text !== "string") throw new UserError("Paste the letter text.");
      if (sentDate !== undefined && typeof sentDate !== "string") throw new UserError("Sent date must be YYYY-MM-DD.");
      const id = saveLetter(p, { text, sentDate });
      log(`saved letter ${id}`);
      return json(res, 201, { id, ...(await syncQuietly()) });
    }

    const del = path.match(/^\/api\/letters\/([^/]+)$/);
    if (method === "DELETE" && del) {
      deleteLetter(p, decodeURIComponent(del[1]));
      return json(res, 200, { ok: true, ...(await syncQuietly()) });
    }

    if (method === "GET" && path === "/api/upcoming") {
      const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 42, 1), 366);
      return json(res, 200, { events: upcoming(cachedEvents(p), days) });
    }

    if (method === "POST" && path === "/api/sync") return json(res, 200, await syncQuietly());

    return json(res, 404, { error: "Not found." });
  }

  // After adding or removing a letter, refresh the dates. A failure here
  // (no API key, API down) is reported but doesn't undo the save.
  async function syncQuietly(): Promise<{ synced: boolean; warning?: string }> {
    try {
      await sync(p, log);
      return { synced: true };
    } catch (err: any) {
      log(`sync failed: ${err.message}`);
      return { synced: false, warning: hasApiKey() ? "Saved, but reading the dates failed. Try Refresh dates later." : "Saved. Dates weren't read because no LLM API key is configured." };
    }
  }

  return createServer(async (req, res) => {
    res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (isHttps(req)) res.setHeader("strict-transport-security", "max-age=31536000");
    try {
      await route(req, res);
    } catch (err: any) {
      if (err instanceof UserError) return json(res, err.status, { error: err.message });
      log(`error on ${req.method} ${req.url}: ${err.stack ?? err.message}`);
      // LLM API errors can contain request details, so they're logged, not shown.
      const llm = /^(Claude|OpenAI) API|OpenAI returned/.test(err.message ?? "");
      json(res, llm ? 502 : 500, { error: llm ? "The AI service returned an error. Try again shortly." : "Something went wrong." });
    }
  });
}

// --- helpers ------------------------------------------------------------------

function send(res: ServerResponse, status: number, data: string | Buffer, type: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

function json(res: ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new UserError("That's too large. Letters are limited to 256 KB.", 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new UserError("Invalid JSON.");
  }
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).host; } catch { return undefined; } // e.g. "Origin: null"
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Constant-time comparison; hashing first makes the lengths equal.
function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

// --- start ----------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile(join(ROOT, ".env")); } catch { /* .env is optional */ }

  const password = process.env.APP_PASSWORD ?? "";
  if (password.length < 10) {
    console.error("Set APP_PASSWORD (at least 10 characters) before starting the website. See README.");
    process.exit(1);
  }
  let sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString("hex");
    console.warn("SESSION_SECRET is not set, so everyone is logged out whenever the server restarts.");
  }
  const calendarToken = process.env.CALENDAR_TOKEN;
  if (calendarToken && calendarToken.length < 20) {
    console.error("CALENDAR_TOKEN must be at least 20 characters, since it's the only thing protecting the calendar URL.");
    process.exit(1);
  }
  if (!hasApiKey()) console.warn("No LLM API key set: questions will show matching excerpts only, and dates won't sync.");

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  createAppServer({ paths: paths(), password, sessionSecret, calendarToken, trustProxy: process.env.TRUST_PROXY === "1" })
    .listen(port, host, () => console.log(`School letters website on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`));
}
