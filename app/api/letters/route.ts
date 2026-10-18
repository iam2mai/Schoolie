// List and add letters. Adding saves the file, updates the semantic index (a
// no-op in keyword mode) and refreshes the dates — index/sync failures are
// logged, never fatal, so the save still stands.
import { listLetters, saveLetter, indexSavedLetter, UserError } from "../../../src/app.ts";
import { appPaths, errorResponse, jsonBody } from "../../lib/api.ts";
import { syncQuietly } from "../sync/route.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json({ letters: listLetters(appPaths()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const p = appPaths();
    const { text, sentDate } = await jsonBody(req);
    if (typeof text !== "string") throw new UserError("Paste the letter text.");
    if (sentDate !== undefined && typeof sentDate !== "string") throw new UserError("Sent date must be YYYY-MM-DD.");
    const id = saveLetter(p, { text, sentDate });
    try {
      await indexSavedLetter(p, id);
    } catch (err) {
      console.error("indexing failed:", err instanceof Error ? err.message : err);
    }
    return Response.json({ id, ...(await syncQuietly(p)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
