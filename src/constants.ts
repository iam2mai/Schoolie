// Shared constants for semantic search: the search modes, embedding providers,
// their default models and key env vars, and the default Pinecone index name.
// Kept in one place so the strings aren't repeated across the codebase.

export const SEARCH_MODES = ["keyword", "semantic", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
export const DEFAULT_SEARCH_MODE: SearchMode = "keyword";

export const EMBEDDINGS_PROVIDERS = ["openai", "voyage"] as const;
export type EmbeddingsProvider = (typeof EMBEDDINGS_PROVIDERS)[number];
export const DEFAULT_EMBEDDINGS_PROVIDER: EmbeddingsProvider = "openai";

// The API-key env var each embedding provider reads.
export const EMBEDDINGS_KEY_VAR: Record<EmbeddingsProvider, string> = {
  openai: "OPENAI_API_KEY",
  voyage: "VOYAGE_API_KEY",
};

// Default models, used when the matching *_MODEL env var is unset.
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-3";

export const DEFAULT_PINECONE_INDEX = "school-letters";
