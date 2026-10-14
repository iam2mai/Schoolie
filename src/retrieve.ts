// Retrieval: BM25 keyword search over letter chunks.
//
// BM25 needs no model download and works well for school letters, which are
// full of distinctive words ("excursion", "Year 3", "permission", "Sovereign
// Hill"). The Retriever interface lets you swap in embeddings later
// (see README, "Next steps") without touching the rest of the pipeline.

import type { Chunk } from "./letters.ts";

export interface Hit { chunk: Chunk; score: number }

export interface Retriever {
  search(query: string, k?: number): Hit[];
}

const STOP = new Set(
  "a an and are as at be by for from has have i in is it its me my of on or our please the their this to was we what when where which who will with you your".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop accents: "fête" -> "fete"
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => t.replace(/(ies)$/, "y").replace(/(?<=[a-z]{3})s$/, "")); // tiny stemmer
}

export class BM25Retriever implements Retriever {
  private docs: { chunk: Chunk; tf: Map<string, number>; len: number }[];
  private df = new Map<string, number>();
  private avgLen: number;
  private k1 = 1.4;
  private b = 0.75;

  constructor(chunks: Chunk[]) {
    this.docs = chunks.map((chunk) => {
      const tokens = tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { chunk, tf, len: tokens.length };
    });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, k = 5): Hit[] {
    const N = this.docs.length;
    const terms = [...new Set(tokenize(query))];
    return this.docs
      .map(({ chunk, tf, len }) => {
        let score = 0;
        for (const t of terms) {
          const f = tf.get(t);
          if (!f) continue;
          const df = this.df.get(t)!;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / this.avgLen)));
        }
        // Small boost for newer letters: when two letters match equally,
        // the more recent one (e.g. a "change of date" notice) wins.
        return { chunk, score: score * (1 + recency(chunk.sentDate)) };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

function recency(sentDate: string): number {
  const days = (Date.now() - Date.parse(sentDate)) / 86_400_000;
  return 0.15 * Math.exp(-Math.max(0, days) / 60);
}
