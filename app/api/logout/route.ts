// Log out by clearing the session cookie.
import { clearedCookie } from "../../lib/cookie.ts";

export const runtime = "nodejs";

export function POST(req: Request) {
  return Response.json({ ok: true }, { headers: { "set-cookie": clearedCookie(req) } });
}
