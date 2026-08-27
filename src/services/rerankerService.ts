import axios from "axios";
import { env } from "../config/env";
import { Semaphore } from "../utils/concurrency";
import { logger } from "../utils/logger";
import { getRerankerSettings } from "./aiProviderSettingsService";
import { truncateAtWordBoundary } from "./embeddingInputService";

export interface RerankResult {
  index: number;
  score: number;
}

interface RerankApiResponse {
  results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
  data?: Array<{ index?: number; relevance_score?: number; score?: number }>;
}

// The reranker sits in the live query path, so it gets a hard timeout, a
// concurrency cap, and a cooldown after failures. A slow or dead reranker must
// degrade the ranking, never the availability of search.
const rerankSemaphore = new Semaphore(env.RERANKER_CONCURRENCY);
const FAILURE_COOLDOWN_MS = 30_000;
// How often the candidate texts are shortened when the server rejects the pair
// as too long, and by how much each time.
const MAX_INPUT_SHRINK_ATTEMPTS = 3;
const INPUT_SHRINK_FACTOR = 0.6;

let cooldownUntil = 0;
let cooldownLogged = false;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// The reranker scores each (query, document) pair in one forward pass, so an
// overlong document is rejected exactly like an overlong embedding input. The
// character cap is only a first approximation - see RERANKER_DOCUMENT_MAX_CHARS
// - so a rejection is answered by shortening and retrying rather than by
// guessing a lower cap that would needlessly starve ordinary text.
function isInputTooLargeResponse(error: unknown): boolean {
  if (!axios.isAxiosError(error) || !error.response) {
    return false;
  }

  const data = error.response.data as { error?: { message?: string } } | string | undefined;
  const message = typeof data === "string" ? data : data?.error?.message ?? "";
  return /too large|too long|physical batch size|maximum context length|exceeds? the maximum/i.test(message);
}

function parseResults(payload: RerankApiResponse, documentCount: number): RerankResult[] {
  const rows = payload.results ?? payload.data ?? [];
  const seen = new Set<number>();
  const results: RerankResult[] = [];

  for (const row of rows) {
    const index = Number(row.index);
    // `relevance_score` is the Cohere/Jina/llama.cpp field name; `score` covers
    // the servers that follow the older TEI shape.
    const score = Number(row.relevance_score ?? row.score);

    if (!Number.isInteger(index) || index < 0 || index >= documentCount || seen.has(index)) {
      continue;
    }
    if (!Number.isFinite(score)) {
      continue;
    }

    seen.add(index);
    results.push({ index, score });
  }

  return results.sort((left, right) => right.score - left.score);
}

export class RerankerService {
  async isConfigured(): Promise<boolean> {
    const settings = await getRerankerSettings();
    return settings.enabled && Boolean(settings.baseUrl) && Boolean(settings.model);
  }

  async getTopN(): Promise<number> {
    const settings = await getRerankerSettings();
    return settings.topN;
  }

  // Returns null whenever reranking could not be performed - disabled, not
  // configured, in cooldown, or the request failed. The caller then keeps the
  // fusion order (or falls back to the lexical heuristic).
  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[] | null> {
    const settings = await getRerankerSettings();
    if (!settings.enabled || !settings.baseUrl || !settings.model) {
      return null;
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery || documents.length === 0) {
      return null;
    }

    if (Date.now() < cooldownUntil) {
      return null;
    }

    try {
      const results = await rerankSemaphore.run(() =>
        this.request(settings.baseUrl as string, settings.model as string, trimmedQuery, documents, topN ?? settings.topN)
      );

      if (cooldownLogged) {
        logger.info({ baseUrl: settings.baseUrl }, "reranker is responding again");
        cooldownLogged = false;
      }

      return results.length > 0 ? results : null;
    } catch (error) {
      cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      if (!cooldownLogged) {
        logger.warn(
          { err: error, baseUrl: settings.baseUrl, cooldownMs: FAILURE_COOLDOWN_MS },
          "reranker request failed, falling back to heuristic ranking"
        );
        cooldownLogged = true;
      }
      return null;
    }
  }

  private async request(
    baseUrl: string,
    model: string,
    query: string,
    documents: string[],
    topN: number
  ): Promise<RerankResult[]> {
    const root = trimTrailingSlash(baseUrl);
    const cappedDocuments = documents.map((document) =>
      truncateAtWordBoundary(document, env.RERANKER_DOCUMENT_MAX_CHARS)
    );
    const body = {
      model,
      query,
      documents: cappedDocuments,
      top_n: Math.min(Math.max(topN, 1), documents.length)
    };

    // llama.cpp, vLLM, Infinity and Jina/Cohere-compatible servers expose
    // /v1/rerank; TEI and some older builds only expose /rerank.
    const candidatePaths = root.endsWith("/v1") ? ["/rerank"] : ["/v1/rerank", "/rerank"];
    let lastError: unknown = null;

    for (const path of candidatePaths) {
      try {
        return await this.postWithShrink(`${root}${path}`, body, documents.length);
      } catch (error) {
        lastError = error;
        // Only a missing endpoint justifies trying the next path; a timeout or
        // a 500 means the right endpoint is simply not healthy.
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("reranker request failed");
  }

  private async postWithShrink(
    url: string,
    body: { model: string; query: string; documents: string[]; top_n: number },
    documentCount: number
  ): Promise<RerankResult[]> {
    let payload = body;

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await axios.post<RerankApiResponse>(url, payload, {
          timeout: env.RERANKER_TIMEOUT_MS
        });
        return parseResults(response.data, documentCount);
      } catch (error) {
        if (!isInputTooLargeResponse(error) || attempt >= MAX_INPUT_SHRINK_ATTEMPTS) {
          throw error;
        }

        // Which candidate was too long is not reported, so every document is
        // shortened. This costs one extra round trip on an outlier batch and
        // keeps the reranker usable instead of silently falling back.
        const shorter = payload.documents.map((document) =>
          truncateAtWordBoundary(document, Math.floor(document.length * INPUT_SHRINK_FACTOR))
        );
        if (shorter.every((document, index) => document.length === payload.documents[index].length)) {
          throw error;
        }

        logger.warn(
          { attempt: attempt + 1, maxChars: Math.max(...shorter.map((document) => document.length)) },
          "reranker rejected the request as too long, retrying with shortened candidates"
        );
        payload = { ...payload, documents: shorter };
      }
    }
  }

  async checkHealth(): Promise<{ enabled: boolean; reachable: boolean; error: string | null }> {
    const settings = await getRerankerSettings();
    if (!settings.enabled || !settings.baseUrl || !settings.model) {
      return { enabled: false, reachable: false, error: null };
    }

    try {
      // A one-document rerank is the only universally available health signal -
      // not every reranking server exposes /v1/models.
      await this.request(settings.baseUrl, settings.model, "health check", ["health check"], 1);
      return { enabled: true, reachable: true, error: null };
    } catch (error) {
      return {
        enabled: true,
        reachable: false,
        error: error instanceof Error ? error.message : "unknown error"
      };
    }
  }
}

export const rerankerService = new RerankerService();
