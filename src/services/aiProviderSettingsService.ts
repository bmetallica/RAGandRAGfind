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
  updatedAt: string | null;
}

interface AiProviderSettingsRow {
  provider: AiProvider;
  base_url: string;
  api_key: string | null;
  embedding_model: string;
  summary_model: string;
  classifier_model: string;
  embedding_dimension: number;
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
}

async function loadFromDb(): Promise<AiProviderSettingsRow> {
  await seedFromEnvIfMissing();

  const result = await pool.query<AiProviderSettingsRow>(
    `
      SELECT provider, base_url, api_key, embedding_model, summary_model, classifier_model, embedding_dimension, updated_at::text
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

export interface UpdateAiProviderSettingsInput {
  provider: AiProvider;
  baseUrl: string;
  apiKey?: string | null;
  embeddingModel: string;
  summaryModel: string;
  classifierModel: string;
  embeddingDimension: number;
}

export async function updateAiProviderSettings(input: UpdateAiProviderSettingsInput): Promise<AiProviderSettingsRecord> {
  const provider = input.provider;
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("base URL must not be empty");
  }
  if (provider === "openai") {
    const current = await ensureLoaded();
    const hasExistingKey = Boolean(current.api_key && current.api_key.trim());
    const hasNewKey = typeof input.apiKey === "string" && input.apiKey.trim().length > 0;
    if (!hasExistingKey && !hasNewKey) {
      throw new Error("an API key is required when using an OpenAI-compatible provider");
    }
  }

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

  await pool.query(
    `
      UPDATE ai_provider_settings
      SET
        provider = $1,
        base_url = $2,
        api_key = COALESCE($3, api_key),
        embedding_model = $4,
        summary_model = $5,
        classifier_model = $6,
        embedding_dimension = $7,
        updated_at = NOW()
      WHERE singleton = TRUE
    `,
    [provider, baseUrl, apiKeyParam, embeddingModel, summaryModel, classifierModel, input.embeddingDimension]
  );

  const row = await ensureLoaded(true);
  return toRecord(row);
}
