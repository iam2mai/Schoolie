// Upcoming events from the cached dates, within a day window (default 6 weeks).
import { upcoming, cachedEvents } from "../../../src/app.ts";
import { appPaths, errorResponse } from "../../lib/api.ts";

export const runtime = "nodejs";

export function GET(req: Request) {
  try {
    const raw = Number(new URL(req.url).searchParams.get("days")) || 42;
    const days = Math.min(Math.max(raw, 1), 366);
    return Response.json({ events: upcoming(cachedEvents(appPaths()), days) });
  } catch (err) {
    return errorResponse(err);
  }
}
