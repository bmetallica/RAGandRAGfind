import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { IngestionService } from "./ingestionService";
import { createKnowledgeBase, normalizeSlug } from "./adminAccessService";
import { isSupportedDocument } from "../utils/files";
import { runWithConcurrency } from "../utils/concurrency";
import { logger } from "../utils/logger";

const DEFAULT_KNOWLEDGE_BASE_SLUG = "default";

interface KnowledgeBaseTarget {
  id: number;
  slug: string;
  name: string;
}

interface SyncBucket {
  // `null` while running in single-knowledge-base mode without an explicit target.
  knowledgeBase: KnowledgeBaseTarget | null;
  // Directory the files were collected from, relative to the sync root ("" = root itself).
  directory: string;
  files: string[];
}

export interface DirectorySyncKnowledgeBaseResult {
  knowledgeBaseId: number | null;
  slug: string | null;
  name: string | null;
  directory: string;
  scanned: number;
  imported: number;
  duplicates: number;
}

export interface DirectorySyncResult {
  mode: "per-knowledge-base" | "single-knowledge-base";
  scanned: number;
  imported: number;
  duplicates: number;
  knowledgeBases: DirectorySyncKnowledgeBaseResult[];
  skippedDirectories: string[];
}

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

  async sync(
    rootDir = env.IMPORT_DIR,
    knowledgeBaseId?: number | null
  ): Promise<DirectorySyncResult> {
    const buckets = knowledgeBaseId || !env.SYNC_KNOWLEDGE_BASE_SUBDIRS
      ? await this.collectSingleKnowledgeBaseBuckets(rootDir, knowledgeBaseId ?? null)
      : await this.collectPerKnowledgeBaseBuckets(rootDir);

    const allResults: DirectorySyncKnowledgeBaseResult[] = [];
    for (const bucket of buckets.entries) {
      allResults.push(await this.ingestBucket(rootDir, bucket));
    }

    // An enabled knowledge base whose directory was just created (or left empty)
    // contributes nothing - drop it so the report only lists directories that
    // actually held files.
    const results = allResults.filter((entry) => entry.scanned > 0);

    return {
      mode: buckets.mode,
      scanned: results.reduce((total, entry) => total + entry.scanned, 0),
      imported: results.reduce((total, entry) => total + entry.imported, 0),
      duplicates: results.reduce((total, entry) => total + entry.duplicates, 0),
      knowledgeBases: results,
      skippedDirectories: buckets.skippedDirectories
    };
  }

  // Legacy behaviour: the whole tree below `rootDir` goes into one knowledge
  // base (or into none, when the caller did not pick one).
  private async collectSingleKnowledgeBaseBuckets(
    rootDir: string,
    knowledgeBaseId: number | null
  ): Promise<{ mode: DirectorySyncResult["mode"]; entries: SyncBucket[]; skippedDirectories: string[] }> {
    const knowledgeBase = knowledgeBaseId ? await this.findKnowledgeBaseById(knowledgeBaseId) : null;

    return {
      mode: "single-knowledge-base",
      entries: [
        {
          knowledgeBase,
          directory: "",
          files: await walk(rootDir)
        }
      ],
      skippedDirectories: []
    };
  }

  // Every immediate subdirectory of `rootDir` is one knowledge base, matched by
  // its slug - so `import-dir/vertraege/...` only ever lands in the "vertraege"
  // knowledge base and cannot mix with documents from a sibling directory.
  // Loose files directly in `rootDir` fall back to the default knowledge base.
  private async collectPerKnowledgeBaseBuckets(
    rootDir: string
  ): Promise<{ mode: DirectorySyncResult["mode"]; entries: SyncBucket[]; skippedDirectories: string[] }> {
    await this.ensureKnowledgeBaseDirectories(rootDir);

    const entries = await readdir(rootDir, { withFileTypes: true });
    const buckets: SyncBucket[] = [];
    const skippedDirectories: string[] = [];

    const rootFiles = entries
      .filter((entry) => !entry.isDirectory())
      .map((entry) => path.join(rootDir, entry.name));

    if (rootFiles.some(isSupportedDocument)) {
      const defaultKnowledgeBase = await this.findKnowledgeBaseBySlug(DEFAULT_KNOWLEDGE_BASE_SLUG);
      if (defaultKnowledgeBase) {
        buckets.push({ knowledgeBase: defaultKnowledgeBase, directory: "", files: rootFiles });
      } else {
        logger.warn(
          { rootDir },
          `directory sync found files directly in the sync root but no "${DEFAULT_KNOWLEDGE_BASE_SLUG}" knowledge base to assign them to`
        );
        skippedDirectories.push("");
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const knowledgeBase = await this.resolveKnowledgeBaseForDirectory(entry.name);
      if (!knowledgeBase) {
        logger.warn(
          { rootDir, directory: entry.name },
          "directory sync skipped a subdirectory without a matching knowledge base"
        );
        skippedDirectories.push(entry.name);
        continue;
      }

      buckets.push({
        knowledgeBase,
        directory: entry.name,
        files: await walk(path.join(rootDir, entry.name))
      });
    }

    return { mode: "per-knowledge-base", entries: buckets, skippedDirectories };
  }

  private async ingestBucket(rootDir: string, bucket: SyncBucket): Promise<DirectorySyncKnowledgeBaseResult> {
    const supportedFiles = bucket.files.filter(isSupportedDocument);

    const results = await runWithConcurrency(supportedFiles, env.INGESTION_IO_CONCURRENCY, async (filePath) => {
      const sourceRef = path.relative(rootDir, filePath);
      try {
        return await this.ingestionService.ingestFile({
          filePath,
          sourceType: "directory",
          sourceRef,
          knowledgeBaseId: bucket.knowledgeBase?.id ?? null,
          metadata: {
            rootDir,
            knowledgeBaseSlug: bucket.knowledgeBase?.slug ?? null,
            syncDirectory: bucket.directory || null
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
      knowledgeBaseId: bucket.knowledgeBase?.id ?? null,
      slug: bucket.knowledgeBase?.slug ?? null,
      name: bucket.knowledgeBase?.name ?? null,
      directory: bucket.directory,
      scanned: bucket.files.length,
      imported,
      duplicates
    };
  }

  // Materialises one directory per enabled knowledge base so an operator can
  // simply drop files into the right folder without creating it by hand first.
  private async ensureKnowledgeBaseDirectories(rootDir: string): Promise<void> {
    const result = await pool.query<{ slug: string }>(
      "SELECT slug FROM knowledge_bases WHERE is_enabled = TRUE ORDER BY slug"
    );

    for (const row of result.rows) {
      const directory = this.resolveKnowledgeBaseDirectory(rootDir, row.slug);
      if (!directory) {
        logger.warn({ slug: row.slug }, "skipped creating an import directory for a knowledge base with an unsafe slug");
        continue;
      }

      await mkdir(directory, { recursive: true });
    }
  }

  // Guards against a stored slug that would escape the sync root (`..`,
  // absolute paths, separators) before it is turned into a filesystem path.
  private resolveKnowledgeBaseDirectory(rootDir: string, slug: string): string | null {
    if (!slug || slug !== normalizeSlug(slug)) {
      return null;
    }

    const directory = path.resolve(rootDir, slug);
    const normalizedRoot = path.resolve(rootDir);
    return directory.startsWith(`${normalizedRoot}${path.sep}`) ? directory : null;
  }

  private async resolveKnowledgeBaseForDirectory(directoryName: string): Promise<KnowledgeBaseTarget | null> {
    const existing = await this.findKnowledgeBaseBySlug(directoryName);
    if (existing) {
      return existing;
    }

    const normalizedSlug = normalizeSlug(directoryName);
    if (normalizedSlug !== directoryName) {
      const bySlug = await this.findKnowledgeBaseBySlug(normalizedSlug);
      if (bySlug) {
        return bySlug;
      }
    }

    if (!env.SYNC_AUTO_CREATE_KNOWLEDGE_BASES) {
      return null;
    }

    const created = await createKnowledgeBase({
      name: directoryName,
      slug: normalizedSlug,
      description: `Automatisch aus dem Sync-Verzeichnis "${directoryName}" angelegt`
    });
    logger.info(
      { knowledgeBaseId: created.id, slug: created.slug, directory: directoryName },
      "directory sync created a knowledge base for a new subdirectory"
    );

    return { id: created.id, slug: created.slug, name: created.name };
  }

  private async findKnowledgeBaseBySlug(slug: string): Promise<KnowledgeBaseTarget | null> {
    const result = await pool.query<KnowledgeBaseTarget>(
      "SELECT id, slug, name FROM knowledge_bases WHERE slug = $1 AND is_enabled = TRUE LIMIT 1",
      [slug]
    );

    return result.rows[0] ?? null;
  }

  private async findKnowledgeBaseById(id: number): Promise<KnowledgeBaseTarget | null> {
    const result = await pool.query<KnowledgeBaseTarget>(
      "SELECT id, slug, name FROM knowledge_bases WHERE id = $1 LIMIT 1",
      [id]
    );

    return result.rows[0] ?? null;
  }
}
