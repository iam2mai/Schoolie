// Ask route: thin wrapper over the existing ask() operation in src/app.ts.
// Runs on the Node.js runtime because ask() reads letter files and may call
// out to the LLM / vector store.
import { paths, ask, UserError } from "../../../src/app.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const question =
    body && typeof (body as { question?: unknown }).question === "string"
      ? (body as { question: string }).question.trim()
      : "";
  if (!question) {
    return Response.json({ error: "Ask a question." }, { status: 400 });
  }

  try {
    // src/app.ts computes ROOT from import.meta.url, which webpack rewrites to
    // point inside .next/. Default DATA_DIR to the working directory (the repo
    // root under `next dev`/`next start`) so letters/ and out/ resolve.
    const p = paths({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? process.cwd() });
    const result = await ask(p, question);
    return Response.json(result);
  } catch (err) {
    const status = err instanceof UserError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return Response.json({ error: message }, { status });
  }
}
