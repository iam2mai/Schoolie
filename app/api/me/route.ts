// Status the UI needs. When logged in: whether an LLM key is configured (so it
// can show the "no AI key" notice) and the calendar subscription path, if set.
import { cookies } from "next/headers";
import { hasApiKey } from "../../../src/llm.ts";
import { SESSION_COOKIE, isValidSession } from "../../lib/session.ts";

export const runtime = "nodejs";

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await isValidSession(token))) {
    return Response.json({ authenticated: false });
  }
  const calendarToken = process.env.CALENDAR_TOKEN;
  return Response.json({
    authenticated: true,
    llmConfigured: hasApiKey(),
    calendarPath: calendarToken ? `/calendar/${calendarToken}.ics` : null,
  });
}
