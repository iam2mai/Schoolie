import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createAppServer, type ServerOptions } from "../src/server.ts";
import { paths, type Paths } from "../src/app.ts";

const PASSWORD = "correct horse battery";
const CAL_TOKEN = "a".repeat(32);
const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;

let server: Server;
let base: string;
let p: Paths;
let logs: string[];
let llmReply: () => Response;

async function start(over: Partial<ServerOptions> = {}) {
  p = paths({ DATA_DIR: mkdtempSync(join(tmpdir(), "srv-")) });
  logs = [];
  server = createAppServer({ paths: p, password: PASSWORD, sessionSecret: "s".repeat(64), calendarToken: CAL_TOKEN, log: (m) => logs.push(m), ...over });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// Requests to our server go through; anything else is the LLM API.
beforeEach(async () => {
  process.env = { ...savedEnv, ANTHROPIC_API_KEY: "test" };
  delete process.env.LLM_PROVIDER;
  llmReply = () => new Response(JSON.stringify({ content: [{ type: "text", text: "On Tuesday." }] }));
  globalThis.fetch = (async (url: any, init?: any) =>
    String(url).startsWith(base) ? realFetch(url, init) : llmReply()) as typeof fetch;
  await start();
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  process.env = savedEnv;
  globalThis.fetch = realFetch;
});

function req(path: string, { method = "GET", body, cookie, headers = {} }: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  return fetch(base + path, {
    method,
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...(cookie && { cookie }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(): Promise<string> {
  const res = await req("/api/login", { method: "POST", body: { password: PASSWORD } });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("pages and headers", () => {
  test("serves the page, script and styles without logging in", async () => {
    for (const [path, type] of [["/", "text/html"], ["/app.js", "text/javascript"], ["/style.css", "text/css"]]) {
      const res = await req(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
    }
  });

  test("sets security headers on every response", async () => {
    const res = await req("/");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toBeNull(); // plain http here
  });

  test("does not serve other files", async () => {
    for (const path of ["/server.ts", "/../.env", "/public/app.js", "/.env"]) expect((await req(path)).status).toBe(404);
  });
});

describe("login", () => {
  test("API needs a session", async () => {
    expect(await (await req("/api/me")).json()).toEqual({ authenticated: false });
    for (const [method, path] of [["GET", "/api/letters"], ["POST", "/api/ask"], ["GET", "/api/upcoming"], ["POST", "/api/sync"], ["DELETE", "/api/letters/x.txt"]]) {
      const res = await req(path, { method, body: method === "POST" ? {} : undefined });
      expect(res.status).toBe(401);
    }
  });

  test("right password sets an HttpOnly, SameSite=Strict session cookie", async () => {
    const res = await req("/api/login", { method: "POST", body: { password: PASSWORD } });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^sid=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    const me = await (await req("/api/me", { cookie: cookie.split(";")[0] })).json();
    expect(me).toEqual({ authenticated: true, llmConfigured: true, calendarPath: `/calendar/${CAL_TOKEN}.ics` });
  });

  test("cookie is Secure behind an HTTPS proxy when trusted", async () => {
    await new Promise((r) => server.close(r));
    await start({ trustProxy: true });
    const res = await req("/api/login", { method: "POST", body: { password: PASSWORD }, headers: { "x-forwarded-proto": "https" } });
    expect(res.headers.get("set-cookie")).toMatch(/; Secure$/);
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  test("ignores X-Forwarded-Proto when the proxy isn't trusted", async () => {
    const res = await req("/api/login", { method: "POST", body: { password: PASSWORD }, headers: { "x-forwarded-proto": "https" } });
    expect(res.headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  test("wrong password is refused", async () => {
    for (const password of ["nope", "", 123, null]) {
      const res = await req("/api/login", { method: "POST", body: { password } });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  test("forged, tampered and expired sessions are refused", async () => {
    const real = await login();
    const [, value] = real.split("=");
    const [exp, sig] = value.split(".");
    for (const cookie of [`sid=${Number(exp) + 1000}.${sig}`, `sid=${exp}.${sig}x`, "sid=garbage", `sid=${Date.now() - 1000}.${sig}`]) {
      expect((await req("/api/letters", { cookie })).status).toBe(401);
    }
  });

  test("sessions from a different secret are refused", async () => {
    const cookie = await login();
    await new Promise((r) => server.close(r));
    await start({ sessionSecret: "different".repeat(8) });
    expect((await req("/api/letters", { cookie })).status).toBe(401);
  });

  test("locks out an IP after 10 wrong passwords, even for the right one", async () => {
    for (let i = 0; i < 10; i++) expect((await req("/api/login", { method: "POST", body: { password: "wrong" } })).status).toBe(401);
    const res = await req("/api/login", { method: "POST", body: { password: PASSWORD } });
    expect(res.status).toBe(429);
  });

  test("logout clears the cookie", async () => {
    const res = await req("/api/logout", { method: "POST", body: {} });
    expect(res.headers.get("set-cookie")).toMatch(/^sid=; .*Max-Age=0/);
  });
});

describe("cross-site protection", () => {
  test("refuses requests from another origin", async () => {
    const cookie = await login();
    for (const origin of ["https://evil.example", "null"]) {
      const res = await req("/api/ask", { method: "POST", body: { question: "hi" }, cookie, headers: { origin } });
      expect(res.status).toBe(403);
    }
  });

  test("accepts same-origin requests", async () => {
    const cookie = await login();
    const res = await req("/api/letters", { cookie, headers: { origin: base } });
    expect(res.status).toBe(200);
  });

  test("writes must be JSON, so plain HTML forms can't post", async () => {
    const res = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `password=${PASSWORD}` });
    expect(res.status).toBe(415);
  });
});

describe("asking", () => {
  test("returns the answer and its sources", async () => {
    writeFileSync(join(p.letters, "a.txt"), "Date: 2026-10-12\nExcursion\n\nThe excursion is on Tuesday.");
    const res = await req("/api/ask", { method: "POST", body: { question: "When is the excursion?" }, cookie: await login() });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.answer).toBe("On Tuesday.");
    expect(data.sources[0].letterId).toBe("a.txt");
  });

  test("validates the question", async () => {
    const cookie = await login();
    for (const question of ["", "   ", 42, "x".repeat(1001)]) {
      const res = await req("/api/ask", { method: "POST", body: { question }, cookie });
      expect(res.status).toBe(400);
    }
  });

  test("hides LLM API error details from the browser but logs them", async () => {
    writeFileSync(join(p.letters, "a.txt"), "Excursion");
    llmReply = () => new Response('{"error":"invalid x-api-key sk-ant-123"}', { status: 401 });
    const res = await req("/api/ask", { method: "POST", body: { question: "excursion" }, cookie: await login() });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("sk-ant");
    expect(logs.join("\n")).toContain("Claude API 401");
  });

  test("rejects invalid JSON and oversized bodies", async () => {
    const cookie = await login();
    const bad = await fetch(base + "/api/ask", { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{nope" });
    expect(bad.status).toBe(400);
    const big = await req("/api/letters", { method: "POST", body: { text: "x".repeat(300 * 1024) }, cookie });
    expect(big.status).toBe(413);
  });
});

describe("letters", () => {
  test("add, list and delete, syncing dates each time", async () => {
    const cookie = await login();
    llmReply = () => new Response(JSON.stringify({ content: [{ type: "tool_use", input: { events: [{ title: "Parade", kind: "event", date: "2099-10-30" }] } }] }));

    const add = await req("/api/letters", { method: "POST", body: { text: "Book Week\n\nParade.", sentDate: "2026-10-09" }, cookie });
    expect(add.status).toBe(201);
    expect(await add.json()).toEqual({ id: "2026-10-09-book-week.txt", synced: true });

    const { letters }: any = await (await req("/api/letters", { cookie })).json();
    expect(letters).toEqual([{ id: "2026-10-09-book-week.txt", sentDate: "2026-10-09", title: "Book Week", preview: "Parade." }]);

    const del = await req("/api/letters/2026-10-09-book-week.txt", { method: "DELETE", cookie });
    expect(await del.json()).toEqual({ ok: true, synced: true });
    expect(((await (await req("/api/letters", { cookie })).json()) as any).letters).toEqual([]);
  });

  test("saves the letter even when reading dates fails", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await req("/api/letters", { method: "POST", body: { text: "Notice", sentDate: "2026-10-09" }, cookie: await login() });
    expect(res.status).toBe(201);
    const data: any = await res.json();
    expect(data.synced).toBe(false);
    expect(data.warning).toMatch(/no LLM API key/);
  });

  test("rejects bad input and unknown or path-traversal deletes", async () => {
    const cookie = await login();
    expect((await req("/api/letters", { method: "POST", body: {}, cookie })).status).toBe(400);
    expect((await req("/api/letters", { method: "POST", body: { text: "Hi", sentDate: "tomorrow" }, cookie })).status).toBe(400);
    expect((await req("/api/letters/missing.txt", { method: "DELETE", cookie })).status).toBe(404);
    expect((await req(`/api/letters/${encodeURIComponent("../out/events-cache.json")}`, { method: "DELETE", cookie })).status).toBe(404);
  });
});

describe("dates and calendar", () => {
  beforeEach(() => {
    const cache = {
      "a.txt": { hash: "h", replaces: [], events: [
        { title: "Parade", kind: "event", date: "2099-01-01", letterId: "a.txt", id: "far" },
        { title: "Soon", kind: "event", date: new Date(Date.now() + 3 * 86_400_000).toLocaleDateString("en-CA"), letterId: "a.txt", id: "soon" },
      ] },
    };
    writeFileSync(p.cache, JSON.stringify(cache));
  });

  test("upcoming returns the next N days", async () => {
    const cookie = await login();
    const { events }: any = await (await req("/api/upcoming?days=42", { cookie })).json();
    expect(events.map((e: any) => e.id)).toEqual(["soon"]);
  });

  test("calendar URL works without a login and needs the exact token", async () => {
    const res = await req(`/calendar/${CAL_TOKEN}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const ics = await res.text();
    expect(ics).toContain("SUMMARY:Parade");
    expect(ics).toContain("SUMMARY:Soon");
    expect((await req(`/calendar/${CAL_TOKEN.slice(1)}.ics`)).status).toBe(404);
    expect((await req("/calendar/.ics")).status).toBe(404);
  });

  test("calendar URL is off when no token is configured", async () => {
    await new Promise((r) => server.close(r));
    await start({ calendarToken: undefined });
    expect((await req("/calendar/undefined.ics")).status).toBe(404);
    expect(((await (await req("/api/me", { cookie: await login() })).json()) as any).calendarPath).toBeNull();
  });
});
