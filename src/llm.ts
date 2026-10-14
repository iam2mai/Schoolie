// Minimal LLM client using built-in fetch (no SDKs needed).
//
// Two providers, chosen with LLM_PROVIDER in .env:
//   claude  Anthropic Messages API (default)
//   openai  OpenAI Chat Completions API
// If LLM_PROVIDER is unset, whichever API key is present is used.
//
// Settings are read on each call rather than at import time, because the CLI
// loads .env after its imports have run.

export type Provider = "claude" | "openai";

interface Tool { name: string; description: string; input_schema: object }

export interface LLMRequest {
  system: string;
  user: string;
  maxTokens?: number;
  tool?: Tool; // when set, the model is forced to answer by calling this tool
}

export interface LLMResponse { text: string; toolInput?: any }

const KEY_VAR: Record<Provider, string> = { claude: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

export function provider(): Provider {
  const p = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (p === "claude" || p === "anthropic") return "claude";
  if (p === "openai") return "openai";
  if (p) throw new Error(`Unknown LLM_PROVIDER "${p}". Use "claude" or "openai".`);
  return !process.env.ANTHROPIC_API_KEY && process.env.OPENAI_API_KEY ? "openai" : "claude";
}

export function apiKeyName(): string {
  return KEY_VAR[provider()];
}

export function hasApiKey(): boolean {
  return Boolean(process.env[apiKeyName()]);
}

export function model(): string {
  return provider() === "openai"
    ? process.env.OPENAI_MODEL ?? "gpt-5"
    : process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";
}

export async function callLLM(opts: LLMRequest): Promise<LLMResponse> {
  const key = process.env[apiKeyName()];
  if (!key) throw new Error(`${apiKeyName()} is not set. Add it to .env (see README).`);
  return provider() === "openai" ? callOpenAI(opts, key) : callClaude(opts, key);
}

async function callClaude(opts: LLMRequest, key: string): Promise<LLMResponse> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model(),
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

async function callOpenAI(opts: LLMRequest, key: string): Promise<LLMResponse> {
  const res = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model(),
      // Reasoning models count their thinking against this limit, so leave headroom.
      max_completion_tokens: (opts.maxTokens ?? 1500) * 4,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      ...(opts.tool && {
        tools: [{ type: "function", function: { name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.input_schema } }],
        tool_choice: { type: "function", function: { name: opts.tool.name } },
      }),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);

  const data: any = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  const args = message.tool_calls?.find((c: any) => c.type === "function")?.function?.arguments;
  let toolInput: any;
  if (args) {
    try { toolInput = JSON.parse(args); } catch { throw new Error(`OpenAI returned invalid tool JSON: ${args.slice(0, 200)}`); }
  }
  return { text: message.content ?? "", toolInput };
}
