import { describe, test, expect } from "@jest/globals";
import { searchMode, embeddingsProvider, embeddingsKeyName, makeRetriever, fuse } from "../src/semantic.ts";
import { BM25Retriever, type Hit } from "../src/retrieve.ts";
import type { Chunk } from "../src/letters.ts";

const chunk = (id: string, text = id): Chunk => ({ id, letterId: `${id}.txt`, sentDate: "2026-01-01", text });
const hit = (id: string, score = 1): Hit => ({ chunk: chunk(id), score });

describe("searchMode", () => {
  test("defaults to keyword when unset", () => {
    expect(searchMode({})).toBe("keyword");
  });
  test("reads keyword, semantic, hybrid case-insensitively", () => {
    expect(searchMode({ SEARCH_MODE: "SEMANTIC" })).toBe("semantic");
    expect(searchMode({ SEARCH_MODE: " Hybrid " })).toBe("hybrid");
  });
  test("rejects an unknown mode", () => {
    expect(() => searchMode({ SEARCH_MODE: "fuzzy" })).toThrow(/Unknown SEARCH_MODE/);
  });
});

describe("embeddings provider", () => {
  test("defaults to OpenAI and its key", () => {
    expect(embeddingsProvider({})).toBe("openai");
    expect(embeddingsKeyName({})).toBe("OPENAI_API_KEY");
  });
  test("voyage selects its own key", () => {
    expect(embeddingsKeyName({ EMBEDDINGS_PROVIDER: "voyage" })).toBe("VOYAGE_API_KEY");
  });
  test("rejects an unknown provider", () => {
    expect(() => embeddingsProvider({ EMBEDDINGS_PROVIDER: "cohere" })).toThrow(/Unknown EMBEDDINGS_PROVIDER/);
  });
});

describe("makeRetriever", () => {
  test("keyword mode needs no keys and returns a working BM25 retriever", async () => {
    const r = makeRetriever([chunk("excursion", "Year 3 excursion to the museum")], { SEARCH_MODE: "keyword" });
    expect(r).toBeInstanceOf(BM25Retriever);
    expect((await r.retrieve("excursion"))[0].chunk.id).toBe("excursion");
  });
  test("semantic and hybrid modes construct without touching the network", () => {
    // No API call happens until retrieve() runs, so building these is key-free.
    expect(() => makeRetriever([chunk("a")], { SEARCH_MODE: "semantic" })).not.toThrow();
    expect(() => makeRetriever([chunk("a")], { SEARCH_MODE: "hybrid" })).not.toThrow();
  });
});

describe("fuse (reciprocal rank fusion)", () => {
  test("ranks a chunk found in both lists above one found in only one", () => {
    const keyword = [hit("a"), hit("b")];
    const semantic = [hit("c"), hit("a")];
    const fused = fuse([keyword, semantic]);
    expect(fused[0].chunk.id).toBe("a"); // appears in both
    expect(fused.map((h) => h.chunk.id).sort()).toEqual(["a", "b", "c"]);
  });

  test("rank matters more than list membership count for well-placed hits", () => {
    const first = [hit("top")];
    const second = [hit("x"), hit("y"), hit("z"), hit("top")];
    const fused = fuse([first, second]);
    expect(fused[0].chunk.id).toBe("top");
  });

  test("empty lists fuse to nothing", () => {
    expect(fuse([[], []])).toEqual([]);
  });
});
