// Re-read the letters and refresh the cached dates. A failure (no API key, API
// down) is reported in `warning` rather than thrown, matching the old server.
import { sync } from "../../../src/app.ts";
import { hasApiKey } from "../../../src/llm.ts";
import { appPaths } from "../../lib/api.ts";

export const runtime = "nodejs";

export async function POST() {
  return Response.json(await syncQuietly(appPaths()));
}

export async function syncQuietly(p: ReturnType<typeof appPaths>): Promise<{ synced: boolean; warning?: string }> {
  try {
    await sync(p);
    return { synced: true };
  } catch (err) {
    console.error("sync failed:", err instanceof Error ? err.message : err);
    return {
      synced: false,
      warning: hasApiKey()
        ? "Saved, but reading the dates failed. Try Refresh dates later."
        : "Saved. Dates weren't read because no LLM API key is configured.",
    };
  }
}
