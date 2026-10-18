// Builds the Set-Cookie header for the session cookie, mirroring the old
// server: HttpOnly, SameSite=Strict, and Secure over HTTPS (including behind a
// trusted proxy, where the scheme comes from X-Forwarded-Proto).
import { SESSION_COOKIE, SESSION_MAX_AGE } from "./session.ts";

export function isHttps(req: Request): boolean {
  if (req.headers.get("x-forwarded-proto") === "https" && process.env.TRUST_PROXY === "1") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookie(req: Request, value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}

export const clearedCookie = (req: Request) => sessionCookie(req, "", 0);
export const freshCookie = (req: Request, value: string) => sessionCookie(req, value, SESSION_MAX_AGE);
