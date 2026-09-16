import cron, { ScheduledTask } from "node-cron";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { crawlQueue, gitRepoSyncQueue, syncQueue } from "../queues";
import { logger } from "../utils/logger";

interface ScheduledJobRow {
  id: number;
  job_type: string;
  cron_expression: string;
  payload: Record<string, unknown>;
}

export class SchedulerService {
  private tasks = new Map<number, ScheduledTask>();

  async ensureDefaultSyncSchedule() {
    await pool.query(
      `
        INSERT INTO scheduled_jobs (job_type, cron_expression, payload)
        SELECT $1, $2, $3::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM scheduled_jobs WHERE job_type = $1 AND cron_expression = $2 AND payload = $3::jsonb
        )
      `,
      ["sync", env.SYNC_CRON, JSON.stringify({ rootDir: env.IMPORT_DIR })]
    );
  }

  async reload() {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();

    const result = await pool.query<ScheduledJobRow>(
      "SELECT id, job_type, cron_expression, payload FROM scheduled_jobs WHERE enabled = TRUE ORDER BY id"
    );

    for (const row of result.rows) {
      const task = cron.schedule(row.cron_expression, async () => {
        try {
          if (row.job_type === "crawl") {
            await crawlQueue.add("crawl", {
              startUrl: String(row.payload.startUrl),
              maxDepth: Number(row.payload.maxDepth ?? env.CRAWL_DEFAULT_MAX_DEPTH),
              // Wurde bisher verschluckt: ein geplanter Crawl landete dadurch
              // immer in keiner Wissensdatenbank, egal was im Zeitplan stand.
              knowledgeBaseId: typeof row.payload.knowledgeBaseId === "number" ? row.payload.knowledgeBaseId : null,
              downloadDocuments: row.payload.downloadDocuments !== false,
              downloadImages: row.payload.downloadImages === true
            });
            return;
          }

          if (row.job_type === "sync") {
            await syncQueue.add("sync", {
              rootDir: typeof row.payload.rootDir === "string" ? row.payload.rootDir : env.IMPORT_DIR
            });
            return;
          }

          if (row.job_type === "git-sync") {
            await gitRepoSyncQueue.add("git-sync", {
              repositoryUrl: String(row.payload.repositoryUrl ?? ""),
              branch: typeof row.payload.branch === "string" ? row.payload.branch : null,
              subPath: typeof row.payload.subPath === "string" ? row.payload.subPath : null,
              knowledgeBaseId: typeof row.payload.knowledgeBaseId === "number" ? row.payload.knowledgeBaseId : null
            });
          }
        } catch (error) {
          logger.error({ err: error, scheduleId: row.id }, "failed to enqueue scheduled job");
        }
      });

      this.tasks.set(row.id, task);
    }
  }
}
