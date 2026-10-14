import { describe, test, expect } from "@jest/globals";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLetters, chunkLetter, type Letter } from "../src/letters.ts";

function letterDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "letters-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const letter = (text: string): Letter => ({ id: "l.txt", sentDate: "2026-10-12", text, hash: "h" });

describe("loadLetters", () => {
  test("loads .txt and .md files (any case) and ignores others, sorted by name", () => {
    const dir = letterDir({ "b.md": "B", "a.txt": "A", "C.TXT": "C", "photo.jpg": "x", "notes.pdf": "x" });
    expect(loadLetters(dir).map((l) => l.id)).toEqual(["C.TXT", "a.txt", "b.md"]);
  });

  test("reads the Date: header as the sent date and removes it from the text", () => {
    const dir = letterDir({ "a.txt": "Date: 2026-10-05\nYear 3 Excursion\n\nDear families," });
    const [l] = loadLetters(dir);
    expect(l.sentDate).toBe("2026-10-05");
    expect(l.text).toBe("Year 3 Excursion\n\nDear families,");
  });

  test("Date: header is case-insensitive", () => {
    const [l] = loadLetters(letterDir({ "a.txt": "DATE:2026-01-02\nHi" }));
    expect(l.sentDate).toBe("2026-01-02");
    expect(l.text).toBe("Hi");
  });

  test("falls back to the file's modified date when there is no header", () => {
    const dir = letterDir({ "a.txt": "No date here" });
    utimesSync(join(dir, "a.txt"), new Date("2026-03-15T12:00:00Z"), new Date("2026-03-15T12:00:00Z"));
    const [l] = loadLetters(dir);
    expect(l.sentDate).toBe("2026-03-15");
    expect(l.text).toBe("No date here");
  });

  test("normalises Windows line endings and trims whitespace", () => {
    const [l] = loadLetters(letterDir({ "a.txt": "\r\n  Date: 2026-10-05\r\nTitle\r\n\r\nBody\r\n\r\n" }));
    expect(l.text).toBe("Title\n\nBody");
    expect(l.sentDate).toBe("2026-10-05");
  });

  test("hash depends on the letter text", () => {
    const [a, b, c] = loadLetters(letterDir({ "a.txt": "Same text", "b.txt": "Same text", "c.txt": "Different text" }));
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });
});

describe("chunkLetter", () => {
  test("a short letter is one chunk", () => {
    const chunks = chunkLetter(letter("Book Week\n\nParade on Friday."));
    expect(chunks).toEqual([{ id: "l.txt#0", letterId: "l.txt", sentDate: "2026-10-12", text: "Book Week\n\nParade on Friday." }]);
  });

  test("splits on paragraphs once a chunk would pass the size limit", () => {
    const p = (c: string) => c.repeat(60);
    const chunks = chunkLetter(letter(`Subject\n\n${p("a")}\n\n${p("b")}\n\n${p("c")}`), 100);
    expect(chunks.map((c) => c.id)).toEqual(["l.txt#0", "l.txt#1", "l.txt#2"]);
    expect(chunks[0].text).toBe(`Subject\n\n${p("a")}`);
  });

  test("later chunks start with the letter's first line for context", () => {
    const chunks = chunkLetter(letter(`Year 3 Excursion\n\n${"x".repeat(80)}\n\n${"y".repeat(80)}`), 50);
    expect(chunks).toHaveLength(3);
    expect(chunks[1].text).toBe(`Year 3 Excursion\n\n${"x".repeat(80)}`);
    expect(chunks[2].text).toBe(`Year 3 Excursion\n\n${"y".repeat(80)}`);
  });

  test("never splits a paragraph, even one over the limit", () => {
    const long = "word ".repeat(200).trim();
    const chunks = chunkLetter(letter(long), 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(long);
  });

  test("ignores extra blank lines between paragraphs", () => {
    const chunks = chunkLetter(letter("Title\n\n\n   \n\nBody"));
    expect(chunks[0].text).toBe("Title\n\nBody");
  });
});
