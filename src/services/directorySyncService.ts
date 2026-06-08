import { readdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { IngestionService } from "./ingestionService";
import { isSupportedDocument } from "../utils/files";
import { runWithConcurrency } from "../utils/concurrency";

async function walk(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return walk(fullPath);
      }

      return [fullPath];
    })
  );

  return files.flat();
}

export class DirectorySyncService {
  constructor(private readonly ingestionService = new IngestionService()) {}

  async sync(rootDir = env.IMPORT_DIR, knowledgeBaseId?: number | null): Promise<{ scanned: number; imported: number; duplicates: number }> {
    const files = await walk(rootDir);
    const supportedFiles = files.filter(isSupportedDocument);

    const results = await runWithConcurrency(supportedFiles, env.INGESTION_IO_CONCURRENCY, async (filePath) => {
      const sourceRef = path.relative(rootDir, filePath);
      try {
        return await this.ingestionService.ingestFile({
          filePath,
          sourceType: "directory",
          sourceRef,
          knowledgeBaseId: knowledgeBaseId ?? null,
          metadata: {
            rootDir
          }
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`directory sync failed for file \"${sourceRef}\" (${filePath}): ${reason}`, {
          cause: error
        });
      }
    });

    let imported = 0;
    let duplicates = 0;
    for (const result of results) {
      if (result.duplicate) {
        duplicates += 1;
      } else {
        imported += 1;
      }
    }

    return {
      scanned: files.length,
      imported,
      duplicates
    };
  }
}
