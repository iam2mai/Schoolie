import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventId, extractEvents, syncEvents, applyReplacements, type Cache, type SchoolEvent } from "../src/events.ts";
import type { Letter } from "../src/letters.ts";

const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;

// Fake Claude: `respond` gets the prompt and returns the tool input.
let respond: (user: string) => any;
let prompts: string[];

beforeEach(() => {
  process.env = { ...savedEnv, ANTHROPIC_API_KEY: "test-key" };
  delete process.env.LLM_PROVIDER;
  prompts = [];
  respond = () => ({ events: [] });
  globalThis.fetch = jest.fn<typeof fetch>(async (_url, init) => {
    const user = JSON.parse(init!.body as string).messages[0].content;
    prompts.push(user);
    const input = respond(user);
    return new Response(JSON.stringify({ content: input === undefined ? [] : [{ type: "tool_use", input }] }));
  });
});

afterEach(() => {
  process.env = savedEnv;
  globalThis.fetch = realFetch;
});

const letter = (id: string, sentDate: string, text: string): Letter => ({ id, sentDate, text, hash: `hash-${text}` });

const event = (over: Partial<SchoolEvent>): SchoolEvent => ({ title: "Thing", kind: "event", date: "2026-10-20", letterId: "a.txt", id: "id", ...over });

describe("eventId", () => {
  const base = { letterId: "a.txt", kind: "event" as const, title: "Book Fair", date: "2026-10-26" };

  test("is a stable 12-character hex id", () => {
    expect(eventId(base)).toMatch(/^[0-9a-f]{12}$/);
    expect(eventId(base)).toBe(eventId({ ...base }));
  });

  test("ignores title case", () => {
    expect(eventId({ ...base, title: "BOOK FAIR" })).toBe(eventId(base));
  });

  test("changes with letter, kind, title or date", () => {
    const id = eventId(base);
    expect(eventId({ ...base, letterId: "b.txt" })).not.toBe(id);
    expect(eventId({ ...base, kind: "deadline" })).not.toBe(id);
    expect(eventId({ ...base, title: "Book Parade" })).not.toBe(id);
    expect(eventId({ ...base, date: "2026-10-27" })).not.toBe(id);
  });
});

describe("extractEvents", () => {
  const l = letter("update.txt", "2026-10-12", "The excursion has moved to Tuesday.");

  test("tells the model the sent date and weekday", async () => {
    await extractEvents(l);
    expect(prompts[0]).toContain("Letter sent on 2026-10-12 (Monday).");
    expect(prompts[0]).toContain("<letter>\nThe excursion has moved to Tuesday.\n</letter>");
    expect(prompts[0]).not.toContain("Entries from earlier letters");
  });

  test("lists earlier entries with their ids", async () => {
    await extractEvents(l, [event({ id: "e1", date: "2026-10-22", title: "Year 3 excursion" })]);
    expect(prompts[0]).toContain("Entries from earlier letters:\n- id e1: 2026-10-22 [event] Year 3 excursion");
  });

  test("adds letterId and a stable id to each event", async () => {
    respond = () => ({ events: [{ title: "Excursion", kind: "event", date: "2026-10-27" }] });
    const { events } = await extractEvents(l);
    expect(events).toEqual([
      { title: "Excursion", kind: "event", date: "2026-10-27", letterId: "update.txt", id: eventId({ letterId: "update.txt", kind: "event", title: "Excursion", date: "2026-10-27" }) },
    ]);
  });

  test("drops entries without a title or a real YYYY-MM-DD date", async () => {
    respond = () => ({
      events: [
        { title: "Good", kind: "event", date: "2026-10-27" },
        { kind: "event", date: "2026-10-27" },
        { title: "Vague", kind: "event", date: "next week" },
        { title: "Impossible", kind: "event", date: "2026-13-45" },
        { title: "Short", kind: "event", date: "2026-1-5" },
        null,
      ],
    });
    const { events } = await extractEvents(l);
    expect(events.map((e) => e.title)).toEqual(["Good"]);
  });

  test("keeps only replaced ids that were actually shown to the model", async () => {
    respond = () => ({ events: [], replaces: ["e1", "made-up"] });
    const { replaces } = await extractEvents(l, [event({ id: "e1" })]);
    expect(replaces).toEqual(["e1"]);
  });

  test("returns nothing when the model does not call the tool", async () => {
    respond = () => undefined;
    expect(await extractEvents(l)).toEqual({ events: [], replaces: [] });
  });
});

describe("applyReplacements", () => {
  test("marks replaced entries with the letter that replaced them, and sorts by date", () => {
    const cache: Cache = {
      "a.txt": { hash: "1", events: [event({ id: "old", date: "2026-10-22" }), event({ id: "keep", date: "2026-10-30" })], replaces: [] },
      "b.txt": { hash: "2", events: [event({ id: "new", date: "2026-10-27", letterId: "b.txt" })], replaces: ["old"] },
    };
    const events = applyReplacements(cache);
    expect(events.map((e) => [e.id, e.cancelledBy])).toEqual([
      ["old", "b.txt"],
      ["new", undefined],
      ["keep", undefined],
    ]);
  });

  test("tolerates cache entries without a replaces list", () => {
    const cache = { "a.txt": { hash: "1", events: [event({})] } } as unknown as Cache;
    expect(applyReplacements(cache)).toHaveLength(1);
  });
});

describe("syncEvents", () => {
  // One event per letter, titled after the letter's text.
  beforeEach(() => {
    respond = (user) => {
      const text = user.match(/<letter>\n(.*)\n<\/letter>/)![1];
      return { events: [{ title: text, kind: "event", date: "2026-11-01" }] };
    };
  });

  const cachePath = () => join(mkdtempSync(join(tmpdir(), "sync-")), "cache.json");
  const a = letter("a.txt", "2026-10-01", "A");
  const b = letter("b.txt", "2026-10-05", "B");
  const c = letter("c.txt", "2026-10-09", "C");
  const sentLetters = () => prompts.map((p) => p.match(/<letter>\n(.*)\n<\/letter>/)![1]);

  test("processes letters oldest first, whatever order they are given in", async () => {
    await syncEvents([c, a, b], cachePath(), () => {});
    expect(sentLetters()).toEqual(["A", "B", "C"]);
  });

  test("each letter sees the entries from letters before it", async () => {
    await syncEvents([a, b], cachePath(), () => {});
    expect(prompts[0]).not.toContain("Entries from earlier letters");
    expect(prompts[1]).toMatch(/- id \w+: 2026-11-01 \[event\] A/);
  });

  test("writes the cache and skips unchanged letters next time", async () => {
    const path = cachePath();
    const first = await syncEvents([a, b], path, () => {});
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual(["a.txt", "b.txt"]);

    prompts = [];
    expect(await syncEvents([a, b], path, () => {})).toEqual(first);
    expect(prompts).toHaveLength(0);
  });

  test("an edited letter is re-extracted along with every later letter, but not earlier ones", async () => {
    const path = cachePath();
    await syncEvents([a, b, c], path, () => {});
    prompts = [];
    await syncEvents([a, letter("b.txt", "2026-10-05", "B2"), c], path, () => {});
    expect(sentLetters()).toEqual(["B2", "C"]);
  });

  test("a deleted letter drops out of the cache and results", async () => {
    const path = cachePath();
    await syncEvents([a, b], path, () => {});
    const events = await syncEvents([a], path, () => {});
    expect(events.map((e) => e.letterId)).toEqual(["a.txt"]);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual(["a.txt"]);
  });

  test("logs each letter it sends to the model", async () => {
    const log = jest.fn();
    await syncEvents([a], cachePath(), log);
    expect(log).toHaveBeenCalledWith("  extracting dates from a.txt ...");
  });
});
