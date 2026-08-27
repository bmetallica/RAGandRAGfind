import IORedis from "ioredis";
import { Queue } from "bullmq";
import { env } from "../config/env";

export interface CrawlJobPayload {
  startUrl: string;
  maxDepth?: number;
  knowledgeBaseId?: number | null;
}

export interface SyncJobPayload {
  rootDir?: string;
  knowledgeBaseId?: number | null;
}

export interface IngestJobPayload {
  filePath: string;
  sourceType: string;
  sourceRef: string;
  knowledgeBaseId?: number | null;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface GitRepoSyncJobPayload {
  repositoryUrl: string;
  branch?: string | null;
  subPath?: string | null;
  knowledgeBaseId?: number | null;
}

export interface ReembedJobPayload {
  targetModel: string;
  targetDimension: number;
  batchSize?: number;
  // Re-embed chunks whose model already matches but whose embedding input was
  // built by an older version of the pipeline (see EMBEDDING_INPUT_VERSION).
  force?: boolean;
}

// Empty payload - the worker always claims the next pending batch from the DB
// (see EmbeddingPendingService) and re-enqueues itself while work remains.
export type EmbedPendingJobPayload = Record<string, never>;

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

export const crawlQueue = new Queue<CrawlJobPayload>("crawl", { connection: redisConnection });
export const syncQueue = new Queue<SyncJobPayload>("sync", { connection: redisConnection });
export const ingestQueue = new Queue<IngestJobPayload>("ingest", { connection: redisConnection });
export const gitRepoSyncQueue = new Queue<GitRepoSyncJobPayload>("git-sync", { connection: redisConnection });
export const reembedQueue = new Queue<ReembedJobPayload>("reembed", { connection: redisConnection });
export const embedPendingQueue = new Queue<EmbedPendingJobPayload>("embed-pending", { connection: redisConnection });
