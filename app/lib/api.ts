// Shared helpers for the Next.js route handlers.
import { paths, UserError, type Paths } from "../../src/app.ts";

// src/app.ts computes ROOT from import.meta.url, which the bundler rewrites to
// point inside .next/. Default DATA_DIR to the working directory (the repo root
// under next dev/start) so letters/ and out/ resolve.
export function appPaths(): Paths {
  return paths({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? process.cwd() });
}

// Turn a thrown error into a JSON Response, mirroring the old server: UserError
// messages are safe to show; LLM errors are masked; everything else is generic.
export function errorResponse(err: unknown): Response {
  if (err instanceof UserError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "";
  if (/^(Claude|OpenAI) API|OpenAI returned/.test(message)) {
    return Response.json({ error: "The AI service returned an error. Try again shortly." }, { status: 502 });
  }
  console.error("route error:", message);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}

// Parse a JSON request body into an object (never throws on bad input).
export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
