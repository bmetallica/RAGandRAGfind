import { pool } from "../db/pool";
import { env } from "../config/env";
import type { AiProvider, AiProviderConnection } from "./aiProviderClient";

export interface AiProviderSettingsRecord {
  provider: AiProvider;
  baseUrl: string;
  apiKeySet: boolean;
  embeddingModel: string;
  summaryModel: string;
  classifierModel: string;
  embeddingDimension: number;
  rerankerEnabled: boolean;
  rerankerBaseUrl: string | null;
  rerankerModel: string | null;
  rerankerTopN: number;
  updatedAt: string | null;
}

export interface RerankerSettings {
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  topN: number;
}

interface AiProviderSettingsRow {
  provider: AiProvider;
  base_url: string;
  api_key: string | null;
  embedding_model: string;
  summary_model: string;
  classifier_model: string;
  embedding_dimension: number;
  reranker_enabled: boolean;
  reranker_base_url: string | null;
  reranker_model: string | null;
  reranker_top_n: number;
  updated_at: string;
}

let cached: AiProviderSettingsRow | null = null;
let loadingPromise: Promise<AiProviderSettingsRow> | null = null;

async function seedFromEnvIfMissing(): Promise<void> {
  await pool.query(
    `
      INSERT INTO ai_provider_settings (
        singleton, provider, base_url, api_key, embedding_model, summary_model, classifier_model, embedding_dimension
      )
      VALUES (TRUE, 'ollama', $1, NULL, $2, $3, $4, $5)
      ON CONFLICT (singleton) DO NOTHING
    `,
    [env.OLLAMA_BASE_URL, env.EMBEDDING_MODEL, env.LLM_MODEL, env.DOCUMENT_CLASSIFIER_MODEL, env.EMBEDDING_DIMENSION]
  );

  // The reranker columns arrived with migration 023, so an existing row has
  // them at NULL. Fill them from the environment exactly once - the guard on
  // `reranker_base_url IS NULL` means anything configured through the admin UI
  // afterwards is never overwritten on the next startup.
  if (env.RERANKER_BASE_URL && env.RERANKER_MODEL) {
    await pool.query(
      `
        UPDATE ai_provider_settings
        SET reranker_base_url = $1,
            reranker_model = $2,
            reranker_enabled = $3,
            reranker_top_n = $4
        WHERE singleton = TRUE
          AND reranker_base_url IS NULL
      `,
      [env.RERANKER_BASE_URL, env.RERANKER_MODEL, env.RERANKER_ENABLED, env.RERANKER_TOP_N]
    );
  }
}

async function loadFromDb(): Promise<AiProviderSettingsRow> {
  await seedFromEnvIfMissing();

  const result = await pool.query<AiProviderSettingsRow>(
    `
      SELECT
        provider,
        base_url,
        api_key,
        embedding_model,
        summary_model,
        classifier_model,
        embedding_dimension,
        reranker_enabled,
        reranker_base_url,
        reranker_model,
        reranker_top_n,
        updated_at::text
      FROM ai_provider_settings
      WHERE singleton = TRUE
      LIMIT 1
    `
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("failed to load AI provider settings after seeding");
  }

  return row;
}

async function ensureLoaded(force = false): Promise<AiProviderSettingsRow> {
  if (cached && !force) {
    return cached;
  }

  if (loadingPromise && !force) {
    return loadingPromise;
  }

  loadingPromise = loadFromDb()
    .then((row) => {
      cached = row;
      loadingPromise = null;
      return row;
    })
    .catch((error) => {
      loadingPromise = null;
      throw error;
    });

  return loadingPromise;
}

function toRecord(row: AiProviderSettingsRow): AiProviderSettingsRecord {
  return {
    provider: row.provider,
    baseUrl: row.base_url,
    apiKeySet: Boolean(row.api_key && row.api_key.trim()),
    embeddingModel: row.embedding_model,
    summaryModel: row.summary_model,
    classifierModel: row.classifier_model,
    embeddingDimension: row.embedding_dimension,
    rerankerEnabled: row.reranker_enabled,
    rerankerBaseUrl: row.reranker_base_url,
    rerankerModel: row.reranker_model,
    rerankerTopN: row.reranker_top_n,
    updatedAt: row.updated_at
  };
}

export async function getAiProviderSettings(): Promise<AiProviderSettingsRecord> {
  const row = await ensureLoaded();
  return toRecord(row);
}

export async function getAiProviderConnection(): Promise<AiProviderConnection> {
  const row = await ensureLoaded();
  return {
    provider: row.provider,
    baseUrl: row.base_url,
    apiKey: row.api_key
  };
}

export async function getEmbeddingModelName(): Promise<string> {
  const row = await ensureLoaded();
  return row.embedding_model;
}

export async function getSummaryModelName(): Promise<string> {
  const row = await ensureLoaded();
  return row.summary_model;
}

export async function getClassifierModelName(): Promise<string> {
  const row = await ensureLoaded();
  return row.classifier_model;
}

export async function getEmbeddingDimension(): Promise<number> {
  const row = await ensureLoaded();
  return row.embedding_dimension;
}

export async function getRerankerSettings(): Promise<RerankerSettings> {
  const row = await ensureLoaded();
  return {
    enabled: row.reranker_enabled,
    baseUrl: row.reranker_base_url?.trim() || null,
    model: row.reranker_model?.trim() || null,
    topN: row.reranker_top_n
  };
}

export interface UpdateAiProviderSettingsInput {
  provider: AiProvider;
  baseUrl: string;
  apiKey?: string | null;
  embeddingModel: string;
  summaryModel: string;
  classifierModel: string;
  embeddingDimension: number;
  rerankerEnabled?: boolean;
  rerankerBaseUrl?: string | null;
  rerankerModel?: string | null;
  rerankerTopN?: number;
  // Removes a stored key. Without this an empty `apiKey` means "keep the
  // current one" (so the admin form does not wipe it on every save), which
  // left no way to switch a provider back to unauthenticated.
  clearApiKey?: boolean;
}

export async function updateAiProviderSettings(input: UpdateAiProviderSettingsInput): Promise<AiProviderSettingsRecord> {
  const provider = input.provider;
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("base URL must not be empty");
  }
  // No API key requirement: "openai" covers every OpenAI-compatible server, and
  // the locally hosted ones - vLLM, llama.cpp/llama-swap, LM Studio, TGI - run
  // without authentication unless explicitly started with a key. Demanding one
  // only forced operators to invent a dummy value. A server that does need a
  // key answers with 401, which the reachability check surfaces directly.

  const embeddingModel = input.embeddingModel.trim();
  const summaryModel = input.summaryModel.trim();
  const classifierModel = input.classifierModel.trim();
  if (!embeddingModel || !summaryModel || !classifierModel) {
    throw new Error("embedding, summary, and classifier model must not be empty");
  }
  if (!Number.isFinite(input.embeddingDimension) || input.embeddingDimension <= 0) {
    throw new Error("embedding dimension must be a positive number");
  }

  const apiKeyParam = typeof input.apiKey === "string" && input.apiKey.trim().length > 0
    ? input.apiKey.trim()
    : null;
  const clearApiKey = input.clearApiKey === true && !apiKeyParam;

  const rerankerBaseUrl = input.rerankerBaseUrl?.trim() || null;
  const rerankerModel = input.rerankerModel?.trim() || null;
  const rerankerEnabled = input.rerankerEnabled === true;
  if (rerankerEnabled && (!rerankerBaseUrl || !rerankerModel)) {
    throw new Error("reranker base URL and model are required when the reranker is enabled");
  }

  const rerankerTopN = Number.isFinite(input.rerankerTopN) && Number(input.rerankerTopN) > 0
    ? Math.min(Math.floor(Number(input.rerankerTopN)), 200)
    : env.RERANKER_TOP_N;

  await pool.query(
    `
      UPDATE ai_provider_settings
      SET
        provider = $1,
        base_url = $2,
        api_key = CASE WHEN $12::boolean THEN NULL ELSE COALESCE($3, api_key) END,
        embedding_model = $4,
        summary_model = $5,
        classifier_model = $6,
        embedding_dimension = $7,
        reranker_enabled = $8,
        reranker_base_url = $9,
        reranker_model = $10,
        reranker_top_n = $11,
        updated_at = NOW()
      WHERE singleton = TRUE
    `,
    [
      provider,
      baseUrl,
      apiKeyParam,
      embeddingModel,
      summaryModel,
      classifierModel,
      input.embeddingDimension,
      rerankerEnabled,
      rerankerBaseUrl,
      rerankerModel,
      rerankerTopN,
      clearApiKey
    ]
  );

  const row = await ensureLoaded(true);
  return toRecord(row);
}
