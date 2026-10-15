import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveLetter, deleteLetter, listLetters, upcoming, ask, sync, today, UserError, type Paths } from "../src/app.ts";
import type { SchoolEvent } from "../src/events.ts";

const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
let p: Paths;

beforeEach(() => {
  process.env = { ...savedEnv };
  for (const k of ["LLM_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LETTERS_DIR"]) delete process.env[k];
  p = paths({ DATA_DIR: mkdtempSync(join(tmpdir(), "app-")) });
});

afterEach(() => {
  process.env = savedEnv;
  globalThis.fetch = realFetch;
});

const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("en-CA");

describe("paths", () => {
  test("puts letters and out under DATA_DIR and creates them", () => {
    const data = mkdtempSync(join(tmpdir(), "data-"));
    const q = paths({ DATA_DIR: data });
    expect(q).toEqual({ letters: join(data, "letters"), out: join(data, "out"), cache: join(data, "out", "events-cache.json"), ics: join(data, "out", "school-letters.ics") });
    expect(existsSync(q.letters) && existsSync(q.out)).toBe(true);
  });

  test("LETTERS_DIR overrides only the letters folder", () => {
    const data = mkdtempSync(join(tmpdir(), "data-"));
    const letters = mkdtempSync(join(tmpdir(), "letters-"));
    const q = paths({ DATA_DIR: data, LETTERS_DIR: letters });
    expect(q.letters).toBe(letters);
    expect(q.out).toBe(join(data, "out"));
  });
});

describe("saveLetter", () => {
  test("saves with a Date header, named by date and subject", () => {
    const id = saveLetter(p, { text: "Book Week Parade!\n\nFriday 30 October.", sentDate: "2026-10-09" });
    expect(id).toBe("2026-10-09-book-week-parade.txt");
    expect(readFileSync(join(p.letters, id), "utf8")).toBe("Date: 2026-10-09\nBook Week Parade!\n\nFriday 30 October.\n");
  });

  test("uses a Date: line in the text when no date is given, without repeating it", () => {
    const id = saveLetter(p, { text: "Date: 2026-10-05\r\nExcursion\r\n\r\nDetails" });
    expect(id).toBe("2026-10-05-excursion.txt");
    expect(readFileSync(join(p.letters, id), "utf8")).toBe("Date: 2026-10-05\nExcursion\n\nDetails\n");
  });

  test("the sent date field wins over a Date: line in the text", () => {
    expect(saveLetter(p, { text: "Date: 2026-10-05\nExcursion", sentDate: "2026-10-06" })).toBe("2026-10-06-excursion.txt");
  });

  test("defaults to today", () => {
    expect(saveLetter(p, { text: "Notice" })).toBe(`${today()}-notice.txt`);
  });

  test("never overwrites a letter with the same name", () => {
    const a = saveLetter(p, { text: "Notice\nOne", sentDate: "2026-10-01" });
    const b = saveLetter(p, { text: "Notice\nTwo", sentDate: "2026-10-01" });
    expect([a, b]).toEqual(["2026-10-01-notice.txt", "2026-10-01-notice-2.txt"]);
    expect(readFileSync(join(p.letters, a), "utf8")).toContain("One");
  });

  test("makes a safe file name from any subject", () => {
    expect(saveLetter(p, { text: "../../etc/passwd", sentDate: "2026-10-01" })).toBe("2026-10-01-etc-passwd.txt");
    expect(saveLetter(p, { text: "日本語のお知らせ", sentDate: "2026-10-01" })).toBe("2026-10-01-letter.txt");
    expect(readdirSync(p.letters)).toHaveLength(2);
  });

  test("rejects empty text and bad dates", () => {
    expect(() => saveLetter(p, { text: "   \n " })).toThrow(UserError);
    expect(() => saveLetter(p, { text: "Hi", sentDate: "12/10/2026" })).toThrow("YYYY-MM-DD");
    expect(() => saveLetter(p, { text: "Hi", sentDate: "2026-02-30x" })).toThrow("YYYY-MM-DD");
  });
});

describe("listLetters", () => {
  test("lists newest first with title and a short preview", () => {
    saveLetter(p, { text: "Old letter\n\nSome   body\ntext", sentDate: "2026-09-01" });
    saveLetter(p, { text: "New letter\n\n" + "x".repeat(300), sentDate: "2026-10-01" });
    const list = listLetters(p);
    expect(list.map((l) => l.title)).toEqual(["New letter", "Old letter"]);
    expect(list[1].preview).toBe("Some body text");
    expect(list[0].preview).toHaveLength(200);
  });
});

describe("deleteLetter", () => {
  test("removes a letter", () => {
    const id = saveLetter(p, { text: "Notice", sentDate: "2026-10-01" });
    deleteLetter(p, id);
    expect(listLetters(p)).toEqual([]);
  });

  test("refuses anything that isn't a letter in the folder", () => {
    writeFileSync(join(p.out, "secret.txt"), "x");
    expect(() => deleteLetter(p, "../out/secret.txt")).toThrow("No such letter.");
    expect(() => deleteLetter(p, "missing.txt")).toThrow("No such letter.");
    expect(existsSync(join(p.out, "secret.txt"))).toBe(true);
  });
});

describe("upcoming", () => {
  const ev = (date: string, over: Partial<SchoolEvent> = {}): SchoolEvent => ({ title: date, kind: "event", date, letterId: "a.txt", id: date, ...over });

  test("keeps active events in the window, sorted, including ones still running", () => {
    const events = [ev(daysFromNow(10)), ev(daysFromNow(-5)), ev(daysFromNow(2)), ev(daysFromNow(60)), ev(daysFromNow(-3), { endDate: daysFromNow(1) }), ev(daysFromNow(3), { cancelledBy: "b.txt" })];
    expect(upcoming(events, 42).map((e) => e.date)).toEqual([daysFromNow(-3), daysFromNow(2), daysFromNow(10)]);
  });
});

describe("ask", () => {
  beforeEach(() => {
    saveLetter(p, { text: "Year 3 Excursion\n\nThe excursion is on Tuesday. Bring a hat.", sentDate: "2026-10-12" });
    saveLetter(p, { text: "Book Week\n\nParade on Friday.", sentDate: "2026-10-09" });
  });

  test("without an API key, returns the matching excerpts only", async () => {
    const res = await ask(p, "what to bring on the excursion");
    expect(res.answer).toBeUndefined();
    expect(res.sources[0]).toEqual({ letterId: "2026-10-12-year-3-excursion.txt", sentDate: "2026-10-12", text: expect.stringContaining("Bring a hat") });
  });

  test("with an API key, sends the excerpts and returns the model's answer", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const fetchMock = jest.fn<typeof fetch>(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "  Bring a hat. [x.txt]\n" }] })));
    globalThis.fetch = fetchMock;
    const res = await ask(p, "what to bring on the excursion");
    expect(res.answer).toBe("Bring a hat. [x.txt]");
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.messages[0].content).toContain('<excerpt letter="2026-10-12-year-3-excursion.txt" sent="2026-10-12">');
    expect(body.messages[0].content).toMatch(/Question: what to bring on the excursion$/);
    expect(body.system).toContain(`Today is ${today()}`);
  });
});

describe("sync", () => {
  test("writes the cache and the .ics file, one sync at a time", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    let running = 0;
    let maxRunning = 0;
    globalThis.fetch = jest.fn<typeof fetch>(async () => {
      maxRunning = Math.max(maxRunning, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return new Response(JSON.stringify({ content: [{ type: "tool_use", input: { events: [{ title: "Parade", kind: "event", date: "2026-10-30" }] } }] }));
    });
    saveLetter(p, { text: "Book Week", sentDate: "2026-10-09" });
    const [a, b] = await Promise.all([sync(p), sync(p)]);
    expect(maxRunning).toBe(1);
    expect(a).toEqual(b);
    expect(readFileSync(p.ics, "utf8")).toContain("SUMMARY:Parade");
    expect(existsSync(p.cache)).toBe(true);
  });

  test("a failed sync doesn't block later ones", async () => {
    saveLetter(p, { text: "Book Week", sentDate: "2026-10-09" });
    await expect(sync(p)).rejects.toThrow("ANTHROPIC_API_KEY is not set");
    process.env.ANTHROPIC_API_KEY = "test";
    globalThis.fetch = jest.fn<typeof fetch>(async () => new Response(JSON.stringify({ content: [{ type: "tool_use", input: { events: [] } }] })));
    await expect(sync(p)).resolves.toEqual([]);
  });
});
