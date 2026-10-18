// Signed session tokens, shared by the login route (Node runtime) and the
// middleware (Edge runtime). Uses Web Crypto (crypto.subtle), which is present
// in both runtimes, so a token signed in one verifies in the other — unlike
// node:crypto, which the middleware can't use.
//
// A token is `<expiry-ms>.<hmac>`, stored in an HttpOnly "sid" cookie. The
// secret comes from SESSION_SECRET; with none set, no token can be made or
// verified, so the app fails closed (everyone is logged out).

export const SESSION_COOKIE = "sid";
export const SESSION_DAYS = 30;
export const SESSION_MAX_AGE = SESSION_DAYS * 86_400; // seconds, for the cookie

export function sessionSecret(): string | null {
  const s = process.env.SESSION_SECRET;
  return s && s.length > 0 ? s : null;
}

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

// Constant-time string comparison (equal lengths: both are base64url HMACs).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A fresh token valid for SESSION_DAYS, or null if no secret is configured.
export async function createSession(): Promise<string | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  const exp = String(Date.now() + SESSION_DAYS * 86_400_000);
  return `${exp}.${await hmac(secret, `session.${exp}`)}`;
}

export async function isValidSession(token: string | undefined): Promise<boolean> {
  const secret = sessionSecret();
  if (!secret || !token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) <= Date.now()) return false;
  return safeEqual(sig, await hmac(secret, `session.${exp}`));
}
