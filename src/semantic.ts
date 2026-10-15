// Semantic (meaning-based) search: embeddings + a Pinecone vector database,
// wired together with LangChain. This is the optional upgrade to the keyword
// search in retrieve.ts; see README "Semantic search".
//
// Nothing here is imported unless SEARCH_MODE is "semantic" or "hybrid", and
// the LangChain packages load lazily, so the default keyword build never
// touches the network and the offline tests stay offline.
//
// Phase 2 covers the read path (querying the index). Writing letters into the
// index lands in Phase 3; until then, semantic/hybrid query whatever is there.

import type { Chunk } from "./letters.ts";
import { BM25Retriever, type Hit, type Retriever } from "./retrieve.ts";
import {
  SEARCH_MODES, DEFAULT_SEARCH_MODE, type SearchMode,
  EMBEDDINGS_PROVIDERS, DEFAULT_EMBEDDINGS_PROVIDER, EMBEDDINGS_KEY_VAR, type EmbeddingsProvider,
  DEFAULT_OPENAI_EMBEDDING_MODEL, DEFAULT_VOYAGE_EMBEDDING_MODEL, DEFAULT_PINECONE_INDEX,
} from "./constants.ts";

export type { SearchMode, EmbeddingsProvider };

export function searchMode(env = process.env): SearchMode {
  const m = env.SEARCH_MODE?.trim().toLowerCase();
  if ((SEARCH_MODES as readonly string[]).includes(m ?? "")) return m as SearchMode;
  if (m) throw new Error(`Unknown SEARCH_MODE "${m}". Use ${SEARCH_MODES.join(", ")}.`);
  return DEFAULT_SEARCH_MODE;
}

// --- embeddings ---------------------------------------------------------------
// OpenAI by default; Voyage AI (Anthropic's recommended embeddings partner)
// when EMBEDDINGS_PROVIDER=voyage. Voyage needs @langchain/community installed
// separately (it conflicts with other peer deps, so it's not a default dep).

export function embeddingsProvider(env = process.env): EmbeddingsProvider {
  const p = env.EMBEDDINGS_PROVIDER?.trim().toLowerCase();
  if ((EMBEDDINGS_PROVIDERS as readonly string[]).includes(p ?? "")) return p as EmbeddingsProvider;
  if (p) throw new Error(`Unknown EMBEDDINGS_PROVIDER "${p}". Use ${EMBEDDINGS_PROVIDERS.join(", ")}.`);
  return DEFAULT_EMBEDDINGS_PROVIDER;
}

// The env var that must hold the embedding provider's API key.
export function embeddingsKeyName(env = process.env): string {
  return EMBEDDINGS_KEY_VAR[embeddingsProvider(env)];
}

async function makeEmbeddings(env = process.env) {
  const apiKey = env[embeddingsKeyName(env)];
  if (!apiKey) throw new Error(`${embeddingsKeyName(env)} is not set. Add it to .env (see README "Semantic search").`);

  if (embeddingsProvider(env) === "voyage") {
    // Non-literal specifier so the type checker doesn't require this optional
    // package (install it with: npm i @langchain/community).
    const voyageModule = "@langchain/community/embeddings/voyage";
    const { VoyageEmbeddings } = await import(voyageModule);
    return new VoyageEmbeddings({ apiKey, modelName: env.VOYAGE_MODEL ?? DEFAULT_VOYAGE_EMBEDDING_MODEL });
  }
  const { OpenAIEmbeddings } = await import("@langchain/openai");
  return new OpenAIEmbeddings({ apiKey, model: env.EMBEDDINGS_MODEL ?? DEFAULT_OPENAI_EMBEDDING_MODEL });
}

// --- Pinecone store -----------------------------------------------------------
// A LangChain PineconeStore over one Pinecone index. Shared by the read path
// here and (in Phase 3) the write path that keeps the index current.

export async function makeStore(env = process.env) {
  const apiKey = env.PINECONE_API_KEY;
  if (!apiKey) throw new Error('PINECONE_API_KEY is not set. Add it to .env (see README "Semantic search").');
  const indexName = env.PINECONE_INDEX ?? DEFAULT_PINECONE_INDEX;

  const { Pinecone } = await import("@pinecone-database/pinecone");
  const { PineconeStore } = await import("@langchain/pinecone");
  const pineconeIndex = new Pinecone({ apiKey }).Index(indexName);
  const embeddings = await makeEmbeddings(env);
  return PineconeStore.fromExistingIndex(embeddings, { pineconeIndex });
}

// --- read path ----------------------------------------------------------------

export class SemanticRetriever implements Retriever {
  private env: NodeJS.ProcessEnv;
  constructor(env = process.env) {
    this.env = env;
  }

  async retrieve(query: string, k = 6): Promise<Hit[]> {
    const store = await makeStore(this.env);
    const results: [any, number][] = await store.similaritySearchWithScore(query, k);
    return results.map(([doc, score]) => ({
      chunk: {
        id: doc.metadata.id,
        letterId: doc.metadata.letterId,
        sentDate: doc.metadata.sentDate,
        text: doc.pageContent,
      },
      score,
    }));
  }
}

// Hybrid search: run keyword and semantic retrieval, then blend them with
// Reciprocal Rank Fusion. RRF ranks by position, not raw score, so BM25's
// scores and cosine similarities (which live on different scales) combine
// fairly: a chunk near the top of either list ranks highly.
export class HybridRetriever implements Retriever {
  private keyword: Retriever;
  private semantic: Retriever;
  private rrfK: number;
  constructor(keyword: Retriever, semantic: Retriever, rrfK = 60) {
    this.keyword = keyword;
    this.semantic = semantic;
    this.rrfK = rrfK;
  }

  async retrieve(query: string, k = 6): Promise<Hit[]> {
    const pool = Math.max(k * 3, 10);
    const [kw, sem] = await Promise.all([
      this.keyword.retrieve(query, pool),
      this.semantic.retrieve(query, pool),
    ]);
    return fuse([kw, sem], this.rrfK).slice(0, k);
  }
}

// Build the retriever for the configured SEARCH_MODE. Keyword needs the local
// chunks; semantic reads only from Pinecone; hybrid uses both.
export function makeRetriever(chunks: Chunk[], env = process.env): Retriever {
  const mode = searchMode(env);
  const keyword = new BM25Retriever(chunks);
  if (mode === "keyword") return keyword;
  const semantic = new SemanticRetriever(env);
  return mode === "semantic" ? semantic : new HybridRetriever(keyword, semantic);
}

// Reciprocal Rank Fusion: each list contributes 1/(rrfK + rank) per chunk, so a
// chunk ranked highly in several lists wins. Exported for its own unit test.
export function fuse(lists: Hit[][], rrfK = 60): Hit[] {
  const scores = new Map<string, number>();
  const chunks = new Map<string, Chunk>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      chunks.set(hit.chunk.id, hit.chunk);
      scores.set(hit.chunk.id, (scores.get(hit.chunk.id) ?? 0) + 1 / (rrfK + rank));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ chunk: chunks.get(id)!, score }))
    .sort((a, b) => b.score - a.score);
}
