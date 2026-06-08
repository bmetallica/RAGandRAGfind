import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

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
  // Measured in tokens (see tokenizerService), not characters - chosen to
  // roughly preserve the previous ~1200/200 character chunk sizes.
  CHUNK_SIZE: z.coerce.number().int().positive().default(300),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(50),
  IMPORT_DIR: z.string().default("/app/import-dir"),
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
