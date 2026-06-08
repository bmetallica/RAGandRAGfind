import { mkdir } from "node:fs/promises";
import { Worker } from "bullmq";
import { env } from "../config/env";
import runStartupMigrations from "../db/startupMigrations";
import { crawlQueue, embedPendingQueue, gitRepoSyncQueue, ingestQueue, reembedQueue, redisConnection, syncQueue, CrawlJobPayload, EmbedPendingJobPayload, GitRepoSyncJobPayload, IngestJobPayload, ReembedJobPayload, SyncJobPayload } from "../queues";
import { CrawlService } from "../services/crawlService";
import { DirectorySyncService } from "../services/directorySyncService";
import { GitRepositorySyncService } from "../services/gitRepositorySyncService";
import { IngestionService } from "../services/ingestionService";
import { ReembeddingService } from "../services/reembeddingService";
import { EmbeddingPendingService } from "../services/embeddingPendingService";
import { logger } from "../utils/logger";

async function startWorker() {
  await mkdir(env.UPLOAD_DIR, { recursive: true });
  await mkdir(env.IMPORT_DIR, { recursive: true });
  await mkdir(env.ORIGINAL_STORAGE_DIR, { recursive: true });
  await mkdir(env.GIT_REPO_CACHE_DIR, { recursive: true });

  await runStartupMigrations();

  const crawlService = new CrawlService();
  const directorySyncService = new DirectorySyncService();
  const gitRepositorySyncService = new GitRepositorySyncService();
  const ingestionService = new IngestionService();
  const reembeddingService = new ReembeddingService();
  const embeddingPendingService = new EmbeddingPendingService();

  const crawlWorker = new Worker<CrawlJobPayload>(
    crawlQueue.name,
    async (job) => crawlService.crawl(job.data),
    { connection: redisConnection, concurrency: 2 }
  );

  const syncWorker = new Worker<SyncJobPayload>(
    syncQueue.name,
    async (job) => directorySyncService.sync(job.data.rootDir, job.data.knowledgeBaseId ?? null),
    { connection: redisConnection, concurrency: 1 }
  );

  const ingestWorker = new Worker<IngestJobPayload>(
    ingestQueue.name,
    async (job) => ingestionService.ingestFile(job.data),
    { connection: redisConnection, concurrency: 2 }
  );

  const gitRepoSyncWorker = new Worker<GitRepoSyncJobPayload>(
    gitRepoSyncQueue.name,
    async (job) => gitRepositorySyncService.sync(job.data),
    { connection: redisConnection, concurrency: 1 }
  );

  const reembedWorker = new Worker<ReembedJobPayload>(
    reembedQueue.name,
    async (job) => reembeddingService.run(job.data),
    { connection: redisConnection, concurrency: 1 }
  );

  // Drains every chunk currently marked `embedding_status = 'pending'` (looping
  // internally - see EmbeddingPendingService.run, mirrors ReembeddingService).
  // Triggered after each ingestion commits; with concurrency 1, jobs queued
  // while a run is in progress simply find nothing left to do and complete
  // immediately, so no self-chaining/re-enqueueing is needed.
  const embedPendingWorker = new Worker<EmbedPendingJobPayload>(
    embedPendingQueue.name,
    async () => embeddingPendingService.run(),
    { connection: redisConnection, concurrency: 1 }
  );

  // Safety net: catch chunks left in `pending` by a crash mid-run (the
  // trigger-after-ingestion above only fires on a clean commit).
  void embedPendingQueue.add("embed-pending", {}).catch((error) => {
    logger.warn({ err: error }, "failed to enqueue startup pending-embedding sweep");
  });

  for (const worker of [crawlWorker, syncWorker, ingestWorker, gitRepoSyncWorker, reembedWorker, embedPendingWorker]) {
    worker.on("completed", (job, result) => {
      logger.info({ queue: worker.name, jobId: job?.id, result }, "job completed");
    });
    worker.on("failed", (job, error) => {
      logger.error(
        {
          queue: worker.name,
          jobId: job?.id,
          jobName: job?.name,
          jobData: job?.data,
          failedReason: error?.message,
          stack: error?.stack,
          err: error
        },
        "job failed"
      );
    });
  }

  logger.info("workers started");
}

startWorker().catch((error) => {
  logger.error({ err: error }, "failed to start worker");
  process.exit(1);
});
