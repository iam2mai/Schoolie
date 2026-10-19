// Ask route: thin wrapper over the existing ask() operation in src/app.ts.
// Runs on the Node.js runtime because ask() reads letter files and may call
// out to the LLM / vector store.
import { ask, UserError } from "../../../src/app.ts";
import { appPaths, errorResponse, jsonBody } from "../../lib/api.ts";

export const runtime = "nodejs";

const MAX_QUESTION = 1000;

export async function POST(req: Request) {
  try {
    const { question } = await jsonBody(req);
    if (typeof question !== "string" || !question.trim()) throw new UserError("Type a question.");
    if (question.length > MAX_QUESTION) throw new UserError(`Questions are limited to ${MAX_QUESTION} characters.`);
    return Response.json(await ask(appPaths(), question.trim()));
  } catch (err) {
    return errorResponse(err);
  }
}
