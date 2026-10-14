// End-to-end tests with the Claude API stubbed out, so they run offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLetters, chunkLetter } from "../src/letters.ts";
import { BM25Retriever } from "../src/retrieve.ts";
import { syncEvents } from "../src/events.ts";
import { toICS } from "../src/ics.ts";

const LETTERS = join(dirname(fileURLToPath(import.meta.url)), "..", "letters");
process.env.ANTHROPIC_API_KEY = "test-key";

// Fake model: returns what a good extraction would for each sample letter.
// For the update letter it "replaces" whichever earlier ids it was shown.
// It answers in whichever API format the request was sent to.
let calls: string[] = [];
let requests: { url: string; body: any; headers: any }[] = [];
globalThis.fetch = (async (url: string, init: any) => {
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

test("retrieval ranks the newer update letter first for an excursion question", () => {
  const letters = loadLetters(LETTERS);
  const hits = new BM25Retriever(letters.flatMap((l) => chunkLetter(l))).search("when is the year 3 excursion", 3);
  assert.equal(hits[0].chunk.letterId, "2026-10-12-excursion-update.txt");
  assert.ok(hits.some((h) => h.chunk.letterId === "2026-10-05-year3-excursion.txt"));
});

test("sync extracts dates, marks moved ones, and caches unchanged letters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slr-"));
  const cache = join(dir, "cache.json");
  const letters = loadLetters(LETTERS);

  calls = [];
  const events = await syncEvents(letters, cache, () => {});
  assert.equal(calls.length, 3);
  assert.ok(existsSync(cache));
  // The update letter was shown the original letter's entries.
  assert.match(calls[2], /Entries from earlier letters/);

  const active = events.filter((e) => !e.cancelledBy);
  const cancelled = events.filter((e) => e.cancelledBy);
  assert.deepEqual(cancelled.map((e) => e.date).sort(), ["2026-10-16", "2026-10-22"]);
  assert.ok(active.some((e) => e.title === "Year 3 excursion" && e.date === "2026-10-27"));
  assert.ok(!events.some((e) => e.title === "Bad entry"));
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, "ids are unique");

  calls = [];
  const again = await syncEvents(letters, cache, () => {});
  assert.equal(calls.length, 0, "unchanged letters are not re-sent to the API");
  assert.deepEqual(again, events);
});

test("ICS output has alerts for active entries and cancels moved ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slr-"));
  const events = await syncEvents(loadLetters(LETTERS), join(dir, "cache.json"), () => {});
  const ics = toICS(events);
  const vevents = ics.split("BEGIN:VEVENT").slice(1);
  assert.equal(vevents.length, events.length);
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "lines are folded");

  const ev = (needle: string) => vevents.find((v) => v.replace(/\r\n /g, "").includes(needle))!;

  // Moved excursion: cancelled, no alarm.
  const old = ev("DTSTART:20261022T090000");
  assert.match(old, /STATUS:CANCELLED/);
  assert.doesNotMatch(old, /VALARM/);

  // New excursion at 9:00: alert at 6pm the evening before = 15 hours earlier.
  assert.match(ev("DTSTART:20261027T090000"), /TRIGGER:-PT15H/);

  // All-day deadline: 6pm three evenings before, and 8am on the day.
  const due = ev("DTSTART;VALUE=DATE:20261021");
  assert.match(due, /SUMMARY:Due: Year 3/);
  assert.match(due, /TRIGGER:-P2DT6H/);
  assert.match(due, /TRIGGER:PT8H/);

  // Multi-day all-day event: DTEND is the day after the last day.
  assert.match(ev("SUMMARY:Book Fair"), /DTEND;VALUE=DATE:20261030/);
});

test("OpenAI provider sends a forced function call and gives the same events", async () => {
  const letters = loadLetters(LETTERS);
  const claude = await syncEvents(letters, join(mkdtempSync(join(tmpdir(), "slr-")), "cache.json"), () => {});

  process.env.LLM_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-openai-key";
  try {
    requests = [];
    const openai = await syncEvents(letters, join(mkdtempSync(join(tmpdir(), "slr-")), "cache.json"), () => {});
    assert.deepEqual(openai, claude);

    const r = requests[0];
    assert.match(r.url, /api\.openai\.com\/v1\/chat\/completions$/);
    assert.equal(r.headers.authorization, "Bearer test-openai-key");
    assert.equal(r.body.messages[0].role, "system");
    assert.deepEqual(r.body.tool_choice, { type: "function", function: { name: "record_events" } });
    assert.equal(r.body.tools[0].function.name, "record_events");
  } finally {
    delete process.env.LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
  }
});
