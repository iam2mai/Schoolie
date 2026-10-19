// Delete one letter, drop it from the semantic index, and refresh the dates.
import { deleteLetter, unindexLetter } from "../../../../src/app.ts";
import { appPaths, errorResponse } from "../../../lib/api.ts";
import { syncQuietly } from "../../sync/route.ts";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const p = appPaths();
    const { id } = await params;
    deleteLetter(p, id);
    try {
      await unindexLetter(id);
    } catch (err) {
      console.error("unindexing failed:", err instanceof Error ? err.message : err);
    }
    return Response.json({ ok: true, ...(await syncQuietly(p)) });
  } catch (err) {
    return errorResponse(err);
  }
}
