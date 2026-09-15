import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

// Env vars are always strings, so `z.coerce.boolean()` would turn "false" into
// `true`. Parse the usual truthy/falsy spellings explicitly instead.
function booleanFromEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return defaultValue;
    }
    if (typeof value === "boolean") {
      return value;
    }

    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
  }, z.boolean());
}

const envSchema = z.object({
  PORT: z.coerce.number().default(3311),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Seed values only - the running configuration is stored in the
  // `ai_provider_settings` table (see aiProviderSettingsService) and managed
  // via the Admin-UI "Config-AI" view. These env vars are only consulted once,
  // to populate that table on first startup against an empty database.
  OLLAMA_BASE_URL: z.string().url(),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),
  LLM_MODEL: z.string().default("gptoss-20b"),
  DOCUMENT_CLASSIFIER_MODEL: z.string().default("qwen2.5:7b"),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(768),
  // Task prefixes for asymmetric embedding models (nomic: "search_document: " /
  // "search_query: ", e5: "passage: " / "query: "). Leave empty to derive them
  // from the model name - see embeddingInputService. Set these only for a model
  // whose name does not match any known pattern.
  EMBEDDING_DOCUMENT_PREFIX: z.string().default(""),
  EMBEDDING_QUERY_PREFIX: z.string().default(""),
  // Hard character budget for a single embedding request. Embedding servers
  // reject an input longer than their physical batch size (llama.cpp: `ubatch`,
  // 512 tokens by default) with a 500, which would otherwise fail the whole
  // batch. CHUNK_SIZE cannot prevent that: it is measured with gpt-tokenizer,
  // while the embedding model tokenizes German roughly twice as densely, so
  // 300 "chunk tokens" can be ~600 model tokens.
  // The default is measured: llama.cpp at ubatch 512 accepts ~1550 characters
  // of German prose, so 1400 leaves headroom for the task prefix. Raise it if
  // the embedding server runs with a larger ubatch; 0 disables the cap.
  EMBEDDING_MAX_INPUT_CHARS: z.coerce.number().int().nonnegative().default(1400),
  // Cross-encoder reranker. Like the AI provider above these are seed values
  // only - the running configuration lives in `ai_provider_settings` and is
  // managed in the Admin-UI "Config-AI" view.
  RERANKER_BASE_URL: z.string().default(""),
  RERANKER_MODEL: z.string().default(""),
  RERANKER_ENABLED: booleanFromEnv(false),
  // Reranking cost grows linearly with the number of candidates sent - see the
  // measurements in migrations/023_reranker_settings.sql.
  RERANKER_TOP_N: z.coerce.number().int().positive().default(12),
  // The reranker sits in the live query path: cap how long a search may wait
  // for it and how many requests may hit it at once.
  RERANKER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Characters of each candidate sent to the reranker. Same constraint as
  // EMBEDDING_MAX_INPUT_CHARS: a (query, document) pair longer than the
  // server's physical batch size is rejected outright. Measured against
  // llama.cpp at ubatch 512, German prose survives up to ~1300 characters, but
  // dense OCR text tokenizes far denser - hence the margin. Raise it when the
  // reranking server runs with a larger ubatch.
  RERANKER_DOCUMENT_MAX_CHARS: z.coerce.number().int().positive().default(900),
  RERANKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  OLLAMA_EMBED_CONCURRENCY: z.coerce.number().int().positive().default(1),
  INGESTION_IO_CONCURRENCY: z.coerce.number().int().positive().default(4),
  QUERY_TOP_K: z.coerce.number().int().positive().default(5),
  QUERY_CANDIDATE_K: z.coerce.number().int().positive().default(40),
  QUERY_MAX_CHUNKS_PER_DOCUMENT: z.coerce.number().int().positive().default(2),
  QUERY_VECTOR_WEIGHT: z.coerce.number().positive().default(0.65),
  QUERY_KEYWORD_WEIGHT: z.coerce.number().positive().default(1.35),
  QUERY_EXACT_MATCH_BOOST: z.coerce.number().nonnegative().default(0.2),
  QUERY_RERANK_TOP_N: z.coerce.number().int().positive().default(12),
  QUERY_SMALL_TO_BIG_WINDOW: z.coerce.number().int().nonnegative().default(1),
  // Characters of a document's text that the fuzzy (trigram) document signal
  // looks at. word_similarity() cost grows with the text length and it runs per
  // candidate document per query term, which made it the single most expensive
  // part of a search. Exact substring hits (`text_hits`) still scan the full
  // 16k preview - only the typo/inflection tolerant pass is windowed. 0 = whole
  // preview.
  QUERY_FUZZY_TEXT_WINDOW: z.coerce.number().int().nonnegative().default(4_000),
  // Measured in tokens (see tokenizerService), not characters - chosen to
  // roughly preserve the previous ~1200/200 character chunk sizes.
  CHUNK_SIZE: z.coerce.number().int().positive().default(300),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(50),
  IMPORT_DIR: z.string().default("/app/import-dir"),
  // When enabled, a directory sync without an explicit knowledge base treats
  // every immediate subdirectory of IMPORT_DIR as one knowledge base (matched
  // by slug), so documents of different knowledge bases cannot mix.
  SYNC_KNOWLEDGE_BASE_SUBDIRS: booleanFromEnv(true),
  // Create a knowledge base for a subdirectory that has no matching slug yet.
  // With this disabled, unknown subdirectories are skipped and reported instead.
  SYNC_AUTO_CREATE_KNOWLEDGE_BASES: booleanFromEnv(true),
  UPLOAD_DIR: z.string().default("/app/data/uploads"),
  ORIGINAL_STORAGE_DIR: z.string().default("/app/data/originals"),
  GIT_REPO_CACHE_DIR: z.string().default("/app/data/git-repos"),
  GIT_REPO_MAX_FILE_BYTES: z.coerce.number().int().positive().default(1_000_000),
  ELASTICSEARCH_URL: z.string().url().optional(),
  ELASTICSEARCH_INDEX_PREFIX: z.string().default("rag"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  CRAWL_DEFAULT_MAX_DEPTH: z.coerce.number().int().nonnegative().default(2),
  SYNC_CRON: z.string().default("*/30 * * * *"),
  LOG_LEVEL: z.string().default("info")
});

export const env = envSchema.parse(process.env);
