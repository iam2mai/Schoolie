// Minimal Claude API client using built-in fetch (no SDK needed).

const API_URL = "https://api.anthropic.com/v1/messages";
export const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

interface Tool { name: string; description: string; input_schema: object }

export async function callClaude(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  tool?: Tool; // when set, the model is forced to answer by calling this tool
}): Promise<{ text: string; toolInput?: any }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env (see README).");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      ...(opts.tool && { tools: [opts.tool], tool_choice: { type: "tool", name: opts.tool.name } }),
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);

  const data: any = await res.json();
  const text = data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const toolInput = data.content.find((b: any) => b.type === "tool_use")?.input;
  return { text, toolInput };
}
