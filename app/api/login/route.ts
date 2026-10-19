// Password login: checks APP_PASSWORD, rate-limits by client IP (10 attempts
// per 15 minutes), and on success sets a signed session cookie.
import { createHash, timingSafeEqual } from "node:crypto";
import { createSession, sessionSecret } from "../../lib/session.ts";
import { freshCookie } from "../../lib/cookie.ts";
import { jsonBody } from "../../lib/api.ts";

export const runtime = "nodejs";

const LOGIN_LIMIT = { attempts: 10, windowMs: 15 * 60_000 };
const failedLogins = new Map<string, { count: number; resetAt: number }>();

// Constant-time comparison; hashing first makes the lengths equal.
function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

// Client IP for rate-limiting. The Request API exposes no verified socket IP,
// so X-Forwarded-For is only trusted behind a proxy that appends it
// (TRUST_PROXY=1), where the real client is the last entry (earlier ones can be
// forged). Without that, a direct client could rotate the header to get a fresh
// allowance on every attempt, so everyone shares one conservative bucket.
function clientIp(req: Request): string {
  if (process.env.TRUST_PROXY !== "1") return "unknown";
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) || "unknown";
}

export async function POST(req: Request) {
  if (!sessionSecret()) {
    return Response.json({ error: "The server is missing SESSION_SECRET, so logins are disabled." }, { status: 500 });
  }

  // Reserve an attempt synchronously, before any await, so concurrent requests
  // can't read the same count and overwrite each other's increments. A
  // malformed request below also consumes its reserved attempt.
  const ip = clientIp(req);
  const now = Date.now();
  const existing = failedLogins.get(ip);
  const entry = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + LOGIN_LIMIT.windowMs };
  if (entry.count >= LOGIN_LIMIT.attempts) {
    return Response.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  }
  entry.count += 1;
  failedLogins.set(ip, entry);

  const { password } = await jsonBody(req);
  const expected = process.env.APP_PASSWORD ?? "";
  if (typeof password !== "string" || !expected || !safeEqual(password, expected)) {
    return Response.json({ error: "Wrong password." }, { status: 401 });
  }

  failedLogins.delete(ip);
  const token = await createSession();
  return Response.json({ ok: true }, { status: 200, headers: { "set-cookie": freshCookie(req, token!) } });
}
