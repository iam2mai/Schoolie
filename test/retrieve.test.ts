import { describe, test, expect } from "@jest/globals";
import { tokenize, BM25Retriever } from "../src/retrieve.ts";
import type { Chunk } from "../src/letters.ts";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const chunk = (id: string, text: string, sentDate = daysAgo(400)): Chunk => ({ id, letterId: `${id}.txt`, sentDate, text });

describe("tokenize", () => {
  test("lowercases, drops punctuation and stop words", () => {
    expect(tokenize("When is the Year 3 excursion, please?")).toEqual(["year", "3", "excursion"]);
  });

  test("stems simple plurals so 'hats' matches 'hat'", () => {
    expect(tokenize("hats")).toEqual(tokenize("hat"));
    expect(tokenize("activities")).toEqual(["activity"]);
  });

  test("leaves short words ending in s alone", () => {
    expect(tokenize("bus")).toEqual(["bus"]);
  });

  test("strips accents", () => {
    expect(tokenize("Café fête")).toEqual(["cafe", "fete"]);
  });

  test("returns nothing for empty or stop-word-only text", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("what is the")).toEqual([]);
  });
});

describe("BM25Retriever", () => {
  const corpus = [
    chunk("excursion", "Year 3 excursion to Melbourne Museum. Bring a hat and water bottle."),
    chunk("bookweek", "Book Week parade. Dress up as a book character."),
    chunk("freeday", "Student free day on Monday. OSHC bookings close Wednesday."),
  ];

  test("ranks the chunk that matches the query first", () => {
    const hits = new BM25Retriever(corpus).search("museum excursion");
    expect(hits[0].chunk.id).toBe("excursion");
  });

  test("returns only chunks that match, highest score first", () => {
    const hits = new BM25Retriever(corpus).search("book parade hat");
    expect(hits.map((h) => h.chunk.id)).toEqual(["bookweek", "excursion"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
  });

  test("returns nothing when no words match", () => {
    expect(new BM25Retriever(corpus).search("swimming carnival")).toEqual([]);
  });

  test("respects the result limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => chunk(`c${i}`, `excursion note ${i}`));
    expect(new BM25Retriever(many).search("excursion", 3)).toHaveLength(3);
    expect(new BM25Retriever(many).search("excursion")).toHaveLength(5);
  });

  test("rarer words count for more than common ones", () => {
    const docs = [
      chunk("a", "school notice school notice"),
      chunk("b", "school notice school sovereign"),
      chunk("c", "school notice"),
    ];
    expect(new BM25Retriever(docs).search("school sovereign")[0].chunk.id).toBe("b");
  });

  test("prefers the newer letter when two match equally", () => {
    const text = "The Year 3 excursion is on Tuesday.";
    const hits = new BM25Retriever([chunk("old", text, daysAgo(30)), chunk("new", text, daysAgo(1))]).search("excursion");
    expect(hits.map((h) => h.chunk.id)).toEqual(["new", "old"]);
  });

  test("handles an empty corpus", () => {
    expect(new BM25Retriever([]).search("excursion")).toEqual([]);
  });
});
