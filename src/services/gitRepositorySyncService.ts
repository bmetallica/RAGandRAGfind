import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { env } from "../config/env";
import { sha256 } from "../utils/hash";
import { isSupportedRepositoryDocument } from "../utils/files";
import { EmptyDocumentError, IngestionService } from "./ingestionService";
import { runWithConcurrency } from "../utils/concurrency";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  "vendor",
  "target",
  "bin",
  "obj"
]);

// Ein Repository bringt immer Dateien mit, aus denen sich nichts lesen laesst:
// leere __init__.py, Platzhalter, .gitkeep-Artige. Jede einzelne davon riss
// bisher den ganzen Lauf mit, weil die Aufnahme bei leerem Text wirft und
// Promise.all beim ersten Fehler aufgibt - aus einem leeren __init__.py wurde
// ein gescheiterter Import von tausenden Dateien. Deshalb wird hier jede Datei
// einzeln abgesichert und das Ergebnis zaehlt, was nicht hineinkam.
type FileOutcome = "imported" | "duplicate" | "empty" | "failed";

export interface GitRepositorySyncOptions {
  repositoryUrl: string;
  branch?: string | null;
  subPath?: string | null;
  knowledgeBaseId?: number | null;
}

async function walkRepository(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
          return [];
        }

        return walkRepository(fullPath);
      }

      return [fullPath];
    })
  );

  return files.flat();
}

async function ensureGitAvailable() {
  await execFileAsync("git", ["--version"]);
}

export class GitRepositorySyncService {
  constructor(private readonly ingestionService = new IngestionService()) {}

  async sync(options: GitRepositorySyncOptions): Promise<{
    scanned: number;
    imported: number;
    duplicates: number;
    skipped: number;
    empty: number;
    failed: number;
    repositoryCommit: string | null;
  }> {
    const repositoryUrl = options.repositoryUrl.trim();
    if (!repositoryUrl) {
      throw new Error("repositoryUrl is required");
    }

    await ensureGitAvailable();
    await mkdir(env.GIT_REPO_CACHE_DIR, { recursive: true });

    const branch = options.branch?.trim() || null;
    const checkoutKey = sha256(`${repositoryUrl}#${branch ?? "default"}`);
    const checkoutDir = path.join(env.GIT_REPO_CACHE_DIR, checkoutKey);

    await rm(checkoutDir, { recursive: true, force: true });
    const cloneArgs = ["clone", "--depth", "1"];
    if (branch) {
      cloneArgs.push("--branch", branch);
    }
    cloneArgs.push(repositoryUrl, checkoutDir);
    await execFileAsync("git", cloneArgs, { maxBuffer: 16 * 1024 * 1024 });

    let repositoryCommit: string | null = null;
    try {
      const commitResult = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: checkoutDir });
      repositoryCommit = commitResult.stdout.trim() || null;
    } catch {
      repositoryCommit = null;
    }

    const requestedSubPath = options.subPath?.trim() || "";
    const repositoryRoot = requestedSubPath ? path.resolve(checkoutDir, requestedSubPath) : checkoutDir;
    const relativeSubPath = path.relative(checkoutDir, repositoryRoot);
    if (relativeSubPath.startsWith("..") || path.isAbsolute(relativeSubPath)) {
      throw new Error("subPath must stay inside the cloned repository");
    }

    await access(repositoryRoot, fsConstants.R_OK);

    const files = await walkRepository(repositoryRoot);
    const eligibleFiles: string[] = [];
    let skipped = 0;

    let empty = 0;

    for (const filePath of files.filter(isSupportedRepositoryDocument)) {
      const fileStat = await stat(filePath);
      if (fileStat.size > env.GIT_REPO_MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }

      // Leere Dateien braucht niemand erst durch die Extraktion zu schicken.
      if (fileStat.size === 0) {
        empty += 1;
        continue;
      }

      eligibleFiles.push(filePath);
    }

    const outcomes = await runWithConcurrency<string, FileOutcome>(
      eligibleFiles,
      env.INGESTION_IO_CONCURRENCY,
      async (filePath) => {
        const relativePath = path.relative(checkoutDir, filePath);
        const sourceRef = `${repositoryUrl}${branch ? `#${branch}` : ""}:${relativePath}`;
        try {
          const result = await this.ingestionService.ingestFile({
            filePath,
            sourceType: "git",
            sourceRef,
            knowledgeBaseId: options.knowledgeBaseId ?? null,
            sourceUrl: repositoryUrl,
            metadata: {
              repositoryUrl,
              repositoryBranch: branch,
              repositoryCommit,
              repositoryRelativePath: relativePath,
              repositorySubPath: requestedSubPath || null,
              gitCheckoutDir: checkoutDir
            }
          });

          return result.duplicate ? "duplicate" : "imported";
        } catch (error) {
          if (error instanceof EmptyDocumentError) {
            logger.debug({ sourceRef }, "git sync skipped a file without readable text");
            return "empty";
          }

          logger.warn({ err: error, sourceRef }, "git sync skipped a file after an error");
          return "failed";
        }
      }
    );

    let imported = 0;
    let duplicates = 0;
    let failed = 0;
    for (const outcome of outcomes) {
      if (outcome === "imported") {
        imported += 1;
      } else if (outcome === "duplicate") {
        duplicates += 1;
      } else if (outcome === "empty") {
        empty += 1;
      } else {
        failed += 1;
      }
    }

    return {
      scanned: files.length,
      imported,
      duplicates,
      skipped,
      empty,
      failed,
      repositoryCommit
    };
  }
}