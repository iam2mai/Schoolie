import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { provider, apiKeyName, hasApiKey, model, callLLM } from "../src/llm.ts";

const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
const TOOL = { name: "record_events", description: "Record events.", input_schema: { type: "object" } };

let fetchMock: jest.Mock<typeof fetch>;
const reply = (body: unknown, status = 200) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
const sent = () => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
};

function setEnv(vars: Record<string, string | undefined>) {
  for (const k of ["LLM_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_MODEL", "OPENAI_MODEL", "OPENAI_BASE_URL"]) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

beforeEach(() => {
  process.env = { ...savedEnv };
  setEnv({});
  fetchMock = jest.fn<typeof fetch>();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  process.env = savedEnv;
  globalThis.fetch = realFetch;
});

describe("provider selection", () => {
  test("defaults to Claude when no keys are set", () => {
    expect(provider()).toBe("claude");
    expect(apiKeyName()).toBe("ANTHROPIC_API_KEY");
    expect(hasApiKey()).toBe(false);
  });

  test("uses OpenAI when only its key is set", () => {
    setEnv({ OPENAI_API_KEY: "sk" });
    expect(provider()).toBe("openai");
    expect(hasApiKey()).toBe(true);
  });

  test("prefers Claude when both keys are set", () => {
    setEnv({ OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "ak" });
    expect(provider()).toBe("claude");
  });

  test("LLM_PROVIDER overrides key detection, ignoring case and spaces", () => {
    setEnv({ ANTHROPIC_API_KEY: "ak", LLM_PROVIDER: " OpenAI " });
    expect(provider()).toBe("openai");
    expect(hasApiKey()).toBe(false);
  });

  test("accepts 'anthropic' as an alias for claude", () => {
    setEnv({ LLM_PROVIDER: "anthropic" });
    expect(provider()).toBe("claude");
  });

  test("rejects an unknown provider", () => {
    setEnv({ LLM_PROVIDER: "gemini" });
    expect(() => provider()).toThrow('Unknown LLM_PROVIDER "gemini"');
  });
});

describe("model", () => {
  test("has a default per provider", () => {
    expect(model()).toBe("claude-sonnet-5-5");
    setEnv({ LLM_PROVIDER: "openai" });
    expect(model()).toBe("gpt-5");
  });

  test("reads overrides at call time", () => {
    setEnv({ CLAUDE_MODEL: "claude-opus-5-5", OPENAI_MODEL: "gpt-4.1" });
    expect(model()).toBe("claude-opus-5-5");
    process.env.LLM_PROVIDER = "openai";
    expect(model()).toBe("gpt-4.1");
  });
});

describe("callLLM", () => {
  test("throws without calling the API when the key is missing", async () => {
    setEnv({ LLM_PROVIDER: "openai" });
    await expect(callLLM({ system: "s", user: "u" })).rejects.toThrow("OPENAI_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("with Claude", () => {
    beforeEach(() => setEnv({ ANTHROPIC_API_KEY: "ak" }));

    test("sends a Messages API request", async () => {
      reply({ content: [{ type: "text", text: "Hi" }] });
      await callLLM({ system: "Be brief.", user: "Hello" });
      const { url, headers, body } = sent();
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(headers["x-api-key"]).toBe("ak");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(body).toEqual({
        model: "claude-sonnet-5-5",
        max_tokens: 1500,
        system: "Be brief.",
        messages: [{ role: "user", content: "Hello" }],
      });
    });

    test("joins text blocks", async () => {
      reply({ content: [{ type: "text", text: "Hello " }, { type: "text", text: "there" }] });
      expect(await callLLM({ system: "s", user: "u" })).toEqual({ text: "Hello there", toolInput: undefined });
    });

    test("forces the tool and returns its input", async () => {
      reply({ content: [{ type: "tool_use", name: "record_events", input: { events: [] } }] });
      const res = await callLLM({ system: "s", user: "u", tool: TOOL, maxTokens: 200 });
      expect(res.toolInput).toEqual({ events: [] });
      const { body } = sent();
      expect(body.max_tokens).toBe(200);
      expect(body.tools).toEqual([TOOL]);
      expect(body.tool_choice).toEqual({ type: "tool", name: "record_events" });
    });

    test("reports API errors with status and body", async () => {
      reply({ error: { message: "overloaded" } }, 529);
      await expect(callLLM({ system: "s", user: "u" })).rejects.toThrow(/Claude API 529: .*overloaded/);
    });
  });

  describe("with OpenAI", () => {
    beforeEach(() => setEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk" }));

    test("sends a Chat Completions request with the system prompt as a message", async () => {
      reply({ choices: [{ message: { content: "Hi" } }] });
      await callLLM({ system: "Be brief.", user: "Hello" });
      const { url, headers, body } = sent();
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(headers.authorization).toBe("Bearer sk");
      expect(body).toEqual({
        model: "gpt-5",
        max_completion_tokens: 6000,
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Hello" },
        ],
      });
    });

    test("uses OPENAI_BASE_URL when set", async () => {
      process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
      reply({ choices: [{ message: { content: "Hi" } }] });
      await callLLM({ system: "s", user: "u" });
      expect(sent().url).toBe("http://localhost:11434/v1/chat/completions");
    });

    test("returns message text, or empty text when content is null", async () => {
      reply({ choices: [{ message: { content: "Answer" } }] });
      expect((await callLLM({ system: "s", user: "u" })).text).toBe("Answer");
      reply({ choices: [{ message: { content: null } }] });
      expect((await callLLM({ system: "s", user: "u" })).text).toBe("");
    });

    test("forces the function and parses its JSON arguments", async () => {
      reply({ choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "record_events", arguments: '{"events":[{"title":"x"}]}' } }] } }] });
      const res = await callLLM({ system: "s", user: "u", tool: TOOL });
      expect(res.toolInput).toEqual({ events: [{ title: "x" }] });
      const { body } = sent();
      expect(body.tools).toEqual([{ type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.input_schema } }]);
      expect(body.tool_choice).toEqual({ type: "function", function: { name: "record_events" } });
    });

    test("toolInput is undefined when the model makes no tool call", async () => {
      reply({ choices: [{ message: { content: "No dates" } }] });
      expect((await callLLM({ system: "s", user: "u", tool: TOOL })).toolInput).toBeUndefined();
    });

    test("throws a clear error on malformed tool JSON", async () => {
      reply({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "record_events", arguments: '{"events": [' } }] } }] });
      await expect(callLLM({ system: "s", user: "u", tool: TOOL })).rejects.toThrow("OpenAI returned invalid tool JSON");
    });

    test("reports API errors with status and body", async () => {
      reply({ error: { message: "Invalid API key" } }, 401);
      await expect(callLLM({ system: "s", user: "u" })).rejects.toThrow(/OpenAI API 401: .*Invalid API key/);
    });
  });
});
