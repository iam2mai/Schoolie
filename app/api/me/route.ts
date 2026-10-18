// Status the UI needs: whether an LLM key is configured (so it can show the
// "no AI key" notice) and the calendar subscription path, if one is set.
// Auth is added in a later phase; for now the app is always "authenticated".
import { hasApiKey } from "../../../src/llm.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const token = process.env.CALENDAR_TOKEN;
  return Response.json({
    authenticated: true,
    llmConfigured: hasApiKey(),
    calendarPath: token ? `/calendar/${token}.ics` : null,
  });
}
