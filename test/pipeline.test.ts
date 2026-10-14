// End-to-end tests with the LLM API stubbed out, so they run offline.
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLetters, chunkLetter } from "../src/letters.ts";
import { BM25Retriever } from "../src/retrieve.ts";
import { syncEvents } from "../src/events.ts";
import { toICS } from "../src/ics.ts";

const LETTERS = join(dirname(fileURLToPath(import.meta.url)), "..", "letters");
const tempCache = () => join(mkdtempSync(join(tmpdir(), "slr-")), "cache.json");
const quiet = () => {};

// Fake model: returns what a good extraction would for each sample letter.
// For the update letter it "replaces" whichever earlier ids it was shown.
// It answers in whichever API format the request was sent to.
let calls: string[] = [];
let requests: { url: string; body: any; headers: any }[] = [];
const realFetch = globalThis.fetch;

const fakeFetch = (async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  const user: string = body.messages.find((m: any) => m.role === "user").content;
  calls.push(user);
  requests.push({ url, body, headers: init.headers });
  let input: any = { events: [] };
  if (user.includes("UPDATE: Year 3 Museum Excursion moved")) {
    const ids = [...user.matchAll(/id (\w+): [\d-]+ \[\w+\] (Year 3 excursion|Year 3 excursion payment and permission slip)/g)].map((m) => m[1]);
    input = {
      events: [
        { title: "Year 3 excursion", kind: "event", date: "2026-10-27", startTime: "09:00", endTime: "14:45", location: "Melbourne Museum" },
        { title: "Year 3 excursion payment and permission slip", kind: "deadline", date: "2026-10-21", actions: ["Pay $28", "Return permission slip"] },
      ],
      replaces: [...ids, "not-a-real-id"],
    };
  } else if (user.includes("Year 3 Excursion to Melbourne Museum")) {
    input = {
      events: [
        { title: "Year 3 excursion", kind: "event", date: "2026-10-22", startTime: "09:00", endTime: "14:45", location: "Melbourne Museum", actions: ["Hat, water bottle, packed lunch"] },
        { title: "Year 3 excursion payment and permission slip", kind: "deadline", date: "2026-10-16", actions: ["Pay $28", "Return permission slip"] },
      ],
    };
  } else if (user.includes("Book Week")) {
    input = {
      events: [
        { title: "Book Week parade", kind: "event", date: "2026-10-30", startTime: "09:15", actions: ["Dress up as a book character"] },
        { title: "Book Fair", kind: "event", date: "2026-10-26", endDate: "2026-10-29" },
        { title: "Student Free Day", kind: "event", date: "2026-11-02" },
        { title: "OSHC bookings for Student Free Day", kind: "deadline", date: "2026-10-28" },
        { title: "Bad entry", kind: "event", date: "sometime" }, // must be filtered out
      ],
    };
  }
  const reply = url.includes("openai")
    ? { choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "record_events", arguments: JSON.stringify(input) } }] } }] }
    : { content: [{ type: "tool_use", name: "record_events", input }] };
  return new Response(JSON.stringify(reply), { status: 200 });
}) as typeof fetch;

const savedEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...savedEnv, ANTHROPIC_API_KEY: "test-key" };
  delete process.env.LLM_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = fakeFetch;
  calls = [];
  requests = [];
});

afterEach(() => {
  process.env = savedEnv;
  globalThis.fetch = realFetch;
});

describe("pipeline", () => {
  test("retrieval ranks the newer update letter first for an excursion question", () => {
    const letters = loadLetters(LETTERS);
    const hits = new BM25Retriever(letters.flatMap((l) => chunkLetter(l))).search("when is the year 3 excursion", 3);
    expect(hits[0].chunk.letterId).toBe("2026-10-12-excursion-update.txt");
    expect(hits.map((h) => h.chunk.letterId)).toContain("2026-10-05-year3-excursion.txt");
  });

  test("sync extracts dates, marks moved ones, and caches unchanged letters", async () => {
    const cache = tempCache();
    const letters = loadLetters(LETTERS);

    const events = await syncEvents(letters, cache, quiet);
    expect(calls).toHaveLength(3);
    expect(existsSync(cache)).toBe(true);
    // The update letter was shown the original letter's entries.
    expect(calls[2]).toMatch(/Entries from earlier letters/);

    const active = events.filter((e) => !e.cancelledBy);
    const cancelled = events.filter((e) => e.cancelledBy);
    expect(cancelled.map((e) => e.date).sort()).toEqual(["2026-10-16", "2026-10-22"]);
    expect(active).toContainEqual(expect.objectContaining({ title: "Year 3 excursion", date: "2026-10-27" }));
    expect(events.map((e) => e.title)).not.toContain("Bad entry");
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);

    calls = [];
    const again = await syncEvents(letters, cache, quiet);
    expect(calls).toHaveLength(0); // unchanged letters are not re-sent to the API
    expect(again).toEqual(events);
  });

  test("ICS output has alerts for active entries and cancels moved ones", async () => {
    const events = await syncEvents(loadLetters(LETTERS), tempCache(), quiet);
    const ics = toICS(events);
    const vevents = ics.split("BEGIN:VEVENT").slice(1);
    expect(vevents).toHaveLength(events.length);
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);

    const ev = (needle: string) => vevents.find((v) => v.replace(/\r\n /g, "").includes(needle))!;

    // Moved excursion: cancelled, no alarm.
    const old = ev("DTSTART:20261022T090000");
    expect(old).toMatch(/STATUS:CANCELLED/);
    expect(old).not.toMatch(/VALARM/);

    // New excursion at 9:00: alert at 6pm the evening before = 15 hours earlier.
    expect(ev("DTSTART:20261027T090000")).toMatch(/TRIGGER:-PT15H/);

    // All-day deadline: 6pm three evenings before, and 8am on the day.
    const due = ev("DTSTART;VALUE=DATE:20261021");
    expect(due).toMatch(/SUMMARY:Due: Year 3/);
    expect(due).toMatch(/TRIGGER:-P2DT6H/);
    expect(due).toMatch(/TRIGGER:PT8H/);

    // Multi-day all-day event: DTEND is the day after the last day.
    expect(ev("SUMMARY:Book Fair")).toMatch(/DTEND;VALUE=DATE:20261030/);
  });

  test("OpenAI provider sends a forced function call and gives the same events", async () => {
    const letters = loadLetters(LETTERS);
    const claude = await syncEvents(letters, tempCache(), quiet);

    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-openai-key";
    requests = [];
    const openai = await syncEvents(letters, tempCache(), quiet);
    expect(openai).toEqual(claude);

    const r = requests[0];
    expect(r.url).toMatch(/api\.openai\.com\/v1\/chat\/completions$/);
    expect(r.headers.authorization).toBe("Bearer test-openai-key");
    expect(r.body.messages[0].role).toBe("system");
    expect(r.body.tool_choice).toEqual({ type: "function", function: { name: "record_events" } });
    expect(r.body.tools[0].function.name).toBe("record_events");
  });
});
