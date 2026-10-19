// Calendar subscription feed, authenticated by the secret token in the URL
// (calendar apps can't log in). The path is /calendar/<token>.ics, so the
// dynamic segment carries the ".ics" suffix.
import { createHash, timingSafeEqual } from "node:crypto";
import { toICS } from "../../../src/ics.ts";
import { cachedEvents, calendarName } from "../../../src/app.ts";
import { appPaths } from "../../lib/api.ts";

export const runtime = "nodejs";

// Constant-time comparison; hashing first makes the lengths equal.
function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

const notFound = () => Response.json({ error: "Not found." }, { status: 404 });

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const expected = process.env.CALENDAR_TOKEN;
  const { token } = await params;
  if (!expected || !token.endsWith(".ics")) return notFound();
  if (!safeEqual(token.slice(0, -4), expected)) return notFound();

  const ics = toICS(cachedEvents(appPaths()), { name: calendarName() });
  return new Response(ics, {
    status: 200,
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" },
  });
}
