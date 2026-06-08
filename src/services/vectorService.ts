import axios from "axios";
import { env } from "../config/env";
import { Semaphore } from "../utils/concurrency";
import { logger } from "../utils/logger";
import { checkReachable, requestEmbeddings, type AiProviderConnection } from "./aiProviderClient";
import { getAiProviderConnection, getEmbeddingDimension, getEmbeddingModelName } from "./aiProviderSettingsService";

const EMBED_RETRY_BASE_DELAY_MS = 1_000;
const EMBED_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
const PROVIDER_HEALTH_CHECK_INTERVAL_MS = 30_000;
const PROVIDER_HEALTH_CHECK_TIMEOUT_MS = 5_000;

// Shared across all VectorService instances and callers (ingestion, re-embedding,
// live queries) so the configured cap on concurrent provider requests is process-wide,
// regardless of how many files are processed in parallel upstream.
const embedSemaphore = new Semaphore(env.OLLAMA_EMBED_CONCURRENCY);

// Tracks whether we've already logged the "provider unreachable" warning, so a
// prolonged outage produces one warning + one recovery notice instead of a log
// line every 30 seconds.
let providerUnreachableLogged = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VectorService {
  async embed(texts: string[], model?: string): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const resolvedModel = model ?? (await getEmbeddingModelName());
    return embedSemaphore.run(() => this.embedWithRetry(texts, resolvedModel));
  }

  // Polls the configured AI provider until it responds, so we don't even attempt
  // an embedding request (and thus don't burn a retry/backoff cycle) while the
  // service is known to be down. Logs the transition exactly once in each
  // direction to avoid spamming the log during a long outage.
  private async waitForProviderReachable(connection: AiProviderConnection): Promise<void> {
    while (true) {
      try {
        await checkReachable(connection, PROVIDER_HEALTH_CHECK_TIMEOUT_MS);
        if (providerUnreachableLogged) {
          logger.info({ baseUrl: connection.baseUrl }, "AI provider is reachable again, resuming embedding");
          providerUnreachableLogged = false;
        }
        return;
      } catch (error) {
        if (!providerUnreachableLogged) {
          logger.warn({ err: error, baseUrl: connection.baseUrl }, "AI provider is unreachable, waiting for it to come back before embedding");
          providerUnreachableLogged = true;
        }
        await delay(PROVIDER_HEALTH_CHECK_INTERVAL_MS);
      }
    }
  }

  // Retries indefinitely on transient/connectivity failures (provider down,
  // network blip, timeout) with exponential backoff capped at five minutes -
  // these resolve themselves once the provider is back. Permanent/configuration
  // errors (embedding dimension or count mismatch - see `requestEmbeddingsChecked`)
  // are NOT retried: waiting longer cannot fix a misconfiguration, and an
  // infinite retry loop would just hide the problem from an operator while
  // holding resources.
  private async embedWithRetry(texts: string[], model: string): Promise<number[][]> {
    let attempt = 0;

    while (true) {
      attempt += 1;
      const connection = await getAiProviderConnection();
      await this.waitForProviderReachable(connection);

      try {
        return await this.requestEmbeddingsChecked(connection, texts, model);
      } catch (error) {
        if (!axios.isAxiosError(error)) {
          throw error;
        }

        const backoffMs = Math.min(EMBED_RETRY_MAX_DELAY_MS, EMBED_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        logger.warn(
          { err: error, attempt, backoffMs },
          "embedding request failed, retrying"
        );
        await delay(backoffMs);
      }
    }
  }

  private async requestEmbeddingsChecked(connection: AiProviderConnection, texts: string[], model: string): Promise<number[][]> {
    const expectedDimension = await getEmbeddingDimension();
    const embeddings = await requestEmbeddings(connection, texts, model);

    if (embeddings.length !== texts.length) {
      throw new Error(`expected ${texts.length} embeddings, received ${embeddings.length}`);
    }

    for (const embedding of embeddings) {
      if (embedding.length !== expectedDimension) {
        throw new Error(
          `embedding dimension mismatch: expected ${expectedDimension}, received ${embedding.length}`
        );
      }
    }

    return embeddings;
  }

  async embedOne(text: string, model?: string): Promise<number[]> {
    const [embedding] = await this.embed([text], model);
    return embedding;
  }

  // Used to probe a candidate embedding model's actual output dimension before
  // accepting a config change (see PATCH /admin/ai-provider/settings) - bypasses
  // the cached settings/dimension check since the model may not be the active one yet.
  async probeEmbeddingDimension(connection: AiProviderConnection, model: string): Promise<number> {
    const [embedding] = await requestEmbeddings(connection, ["dimension probe"], model);
    if (!embedding || embedding.length === 0) {
      throw new Error(`received an empty embedding while probing model "${model}"`);
    }
    return embedding.length;
  }
}
