// Password login: checks APP_PASSWORD, rate-limits by client IP (10 attempts
// per 15 minutes), and on success sets a signed session cookie.
import { createHash, timingSafeEqual } from "node:crypto";
import { createSession, sessionSecret } from "../../lib/session.ts";
import { freshCookie } from "../../lib/cookie.ts";
import { jsonBody } from "../../lib/api.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOGIN_LIMIT = { attempts: 10, windowMs: 15 * 60_000 };
const failedLogins = new Map<string, { count: number; resetAt: number }>();

// Constant-time comparison; hashing first makes the lengths equal.
function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

// Best-effort client IP: behind a trusted proxy the real IP is the last entry
// X-Forwarded-For (earlier ones can be forged); otherwise fall back to the header.
function clientIp(req: Request): string {
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.TRUST_PROXY === "1" && xff.length) return xff[xff.length - 1];
  return xff[0] || "unknown";
}

export async function POST(req: Request) {
  if (!sessionSecret()) {
    return Response.json({ error: "The server is missing SESSION_SECRET, so logins are disabled." }, { status: 500 });
  }

  const ip = clientIp(req);
  const now = Date.now();
  const entry = failedLogins.get(ip);
  if (entry && entry.resetAt > now && entry.count >= LOGIN_LIMIT.attempts) {
    return Response.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  }

  const { password } = await jsonBody(req);
  const expected = process.env.APP_PASSWORD ?? "";
  if (typeof password !== "string" || !expected || !safeEqual(password, expected)) {
    const fresh = !entry || entry.resetAt <= now;
    failedLogins.set(ip, { count: fresh ? 1 : entry.count + 1, resetAt: fresh ? now + LOGIN_LIMIT.windowMs : entry.resetAt });
    return Response.json({ error: "Wrong password." }, { status: 401 });
  }

  failedLogins.delete(ip);
  const token = await createSession();
  return Response.json({ ok: true }, { status: 200, headers: { "set-cookie": freshCookie(req, token!) } });
}
