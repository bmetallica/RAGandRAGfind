import { access, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { sha256 } from "../utils/hash";

const DOCUMENT_FILE_BACKFILL_LOCK = 4_291_002;

export interface DocumentFileRecord {
  id: number;
  documentId: number;
  storageKind: string;
  relativePath: string | null;
  originalName: string | null;
  storedName: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  contentHash: string | null;
  externalUrl: string | null;
  localAvailable: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  downloadUrl: string;
}

interface DocumentFileRow {
  id: number;
  document_id: number;
  storage_kind: string;
  relative_path: string | null;
  original_name: string | null;
  stored_name: string | null;
  mime_type: string | null;
  file_size_bytes: string | null;
  content_hash: string | null;
  external_url: string | null;
  local_available: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface BackfillDocumentRow {
  id: number;
  source_type: string;
  source_ref: string;
  source_url: string | null;
  title: string | null;
  mime_type: string | null;
  metadata: Record<string, unknown> | null;
  document_file_id: number | null;
  existing_original_name: string | null;
}

export interface DocumentFileReference {
  localPath?: string | null;
  externalUrl?: string | null;
  originalName?: string | null;
  mimeType?: string | null;
  metadata?: Record<string, unknown>;
}

function sanitizeFileName(fileName: string): string {
  const normalized = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized || "document.bin";
}

function buildStoredFileName(contentHash: string, sourceName?: string | null): string {
  const extension = sourceName ? path.extname(sourceName) : "";
  return `${contentHash.slice(0, 24)}${extension}`;
}

export function buildDocumentDownloadUrl(documentId: number): string {
  const relativePath = `/api/documents/${documentId}/original`;
  if (!env.PUBLIC_BASE_URL) {
    return relativePath;
  }

  return new URL(relativePath, env.PUBLIC_BASE_URL).toString();
}

async function pathExists(filePath: string | null | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }

  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function persistLocalCopy(documentId: number, filePath: string, originalName?: string | null) {
  const buffer = await readFile(filePath);
  const contentHash = sha256(buffer);
  const sourceName = originalName ?? path.basename(filePath);
  const storedName = buildStoredFileName(contentHash, sourceName);
  const targetDir = path.join(env.ORIGINAL_STORAGE_DIR, String(documentId));
  const targetPath = path.join(targetDir, storedName);

  await mkdir(targetDir, { recursive: true });
  if (!(await pathExists(targetPath))) {
    await copyFile(filePath, targetPath);
  }

  const stats = await stat(targetPath);
  return {
    relativePath: path.relative(env.ORIGINAL_STORAGE_DIR, targetPath),
    storedName,
    fileSizeBytes: stats.size,
    contentHash,
    localAvailable: true
  };
}

function rowToRecord(row: DocumentFileRow): DocumentFileRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    storageKind: row.storage_kind,
    relativePath: row.relative_path,
    originalName: row.original_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes ? Number(row.file_size_bytes) : null,
    contentHash: row.content_hash,
    externalUrl: row.external_url,
    localAvailable: row.local_available,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    downloadUrl: buildDocumentDownloadUrl(row.document_id)
  };
}

export async function upsertDocumentFile(
  client: PoolClient,
  documentId: number,
  reference: DocumentFileReference
): Promise<DocumentFileRecord> {
  const metadata = reference.metadata ?? {};
  const localPath = reference.localPath && await pathExists(reference.localPath)
    ? reference.localPath
    : null;
  const localFile = localPath
    ? await persistLocalCopy(documentId, localPath, reference.originalName ?? null)
    : {
        relativePath: null,
        storedName: null,
        fileSizeBytes: null,
        contentHash: null,
        localAvailable: false
      };

  const result = await client.query<DocumentFileRow>(
    `
      INSERT INTO document_files (
        document_id,
        storage_kind,
        relative_path,
        original_name,
        stored_name,
        mime_type,
        file_size_bytes,
        content_hash,
        external_url,
        local_available,
        metadata,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
      ON CONFLICT (document_id)
      DO UPDATE SET
        storage_kind = EXCLUDED.storage_kind,
        relative_path = EXCLUDED.relative_path,
        original_name = EXCLUDED.original_name,
        stored_name = EXCLUDED.stored_name,
        mime_type = EXCLUDED.mime_type,
        file_size_bytes = EXCLUDED.file_size_bytes,
        content_hash = EXCLUDED.content_hash,
        external_url = EXCLUDED.external_url,
        local_available = EXCLUDED.local_available,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `,
    [
      documentId,
      localFile.localAvailable ? "local" : reference.externalUrl ? "external" : "unavailable",
      localFile.relativePath,
      reference.originalName ?? null,
      localFile.storedName,
      reference.mimeType ?? null,
      localFile.fileSizeBytes,
      localFile.contentHash,
      reference.externalUrl ?? null,
      localFile.localAvailable,
      JSON.stringify(metadata)
    ]
  );

  return rowToRecord(result.rows[0]);
}

function deriveReferenceFromDocument(row: BackfillDocumentRow): DocumentFileReference {
  const metadata = row.metadata ?? {};
  const filePath = typeof metadata.filePath === "string" ? metadata.filePath : null;
  const storedFileName = typeof metadata.storedFileName === "string" ? metadata.storedFileName : null;
  const uploadedFileName = typeof metadata.uploadedFileName === "string" ? metadata.uploadedFileName : null;
  const localPath = filePath
    ?? (storedFileName ? path.join(env.UPLOAD_DIR, storedFileName) : null);

  const originalName = uploadedFileName
    ?? (row.source_type === "directory" ? path.basename(row.source_ref) : null)
    ?? row.title
    ?? path.basename(row.source_ref);

  const externalUrl = row.source_type === "crawl-file" || row.source_type === "crawl"
    ? (row.source_url ?? row.source_ref)
    : null;

  return {
    localPath,
    externalUrl,
    originalName,
    mimeType: row.mime_type,
    metadata: {
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      ...(filePath ? { originalFilePath: filePath } : {}),
      ...(storedFileName ? { uploadedStorageName: storedFileName } : {})
    }
  };
}

function needsDocumentFileRefresh(row: BackfillDocumentRow): boolean {
  if (!row.document_file_id) {
    return true;
  }

  const metadata = row.metadata ?? {};
  const uploadedFileName = typeof metadata.uploadedFileName === "string" ? metadata.uploadedFileName : null;
  if (uploadedFileName && row.existing_original_name !== uploadedFileName) {
    return true;
  }

  return false;
}

export async function backfillStoredDocumentFiles(batchSize = 100): Promise<{ processed: number }> {
  const client = await pool.connect();
  let processed = 0;
  let locked = false;

  try {
    const lockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [DOCUMENT_FILE_BACKFILL_LOCK]
    );
    locked = Boolean(lockResult.rows[0]?.locked);
    if (!locked) {
      return { processed: 0 };
    }

    while (true) {
      const result = await client.query<BackfillDocumentRow>(
        `
          SELECT
            d.id,
            d.source_type,
            d.source_ref,
            d.source_url,
            d.title,
            d.mime_type,
            d.metadata,
            df.id AS document_file_id,
            df.original_name AS existing_original_name
          FROM documents d
          LEFT JOIN document_files df ON df.document_id = d.id
          WHERE df.id IS NULL
             OR (
               jsonb_typeof(d.metadata) = 'object'
               AND d.metadata ? 'uploadedFileName'
               AND COALESCE(df.original_name, '') <> COALESCE(d.metadata->>'uploadedFileName', '')
             )
          ORDER BY d.id ASC
          LIMIT $1
        `,
        [batchSize]
      );

      if (result.rowCount === 0) {
        break;
      }

      for (const row of result.rows) {
        if (!needsDocumentFileRefresh(row)) {
          continue;
        }

        await client.query("BEGIN");
        try {
          await upsertDocumentFile(client, row.id, deriveReferenceFromDocument(row));
          await client.query("COMMIT");
          processed += 1;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    }

    return { processed };
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [DOCUMENT_FILE_BACKFILL_LOCK]);
    }
    client.release();
  }
}

export async function getDocumentFile(documentId: number): Promise<DocumentFileRecord | null> {
  const result = await pool.query<DocumentFileRow>(
    `
      SELECT *
      FROM document_files
      WHERE document_id = $1
      LIMIT 1
    `,
    [documentId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return rowToRecord(result.rows[0]);
}

export async function getDocumentFilesByDocumentIds(documentIds: number[]): Promise<Map<number, DocumentFileRecord>> {
  if (documentIds.length === 0) {
    return new Map();
  }

  const result = await pool.query<DocumentFileRow>(
    `
      SELECT *
      FROM document_files
      WHERE document_id = ANY($1::bigint[])
    `,
    [documentIds]
  );

  // pg liefert bigint als String. Ohne Number() haette die Map Zeichenketten
  // als Schluessel, waehrend die Aufrufer mit Zahlen nachschlagen - der Treffer
  // ging dann immer daneben und die Originaldatei fehlte still in der Liste.
  return new Map(result.rows.map((row) => [Number(row.document_id), rowToRecord(row)]));
}

export async function resolveDocumentLocalFilePath(documentId: number): Promise<string | null> {
  const record = await getDocumentFile(documentId);
  if (!record?.relativePath) {
    return null;
  }

  const resolvedPath = path.join(env.ORIGINAL_STORAGE_DIR, record.relativePath);
  return await pathExists(resolvedPath) ? resolvedPath : null;
}

export async function deleteStoredDocumentAssets(documentId: number): Promise<void> {
  const targetDir = path.join(env.ORIGINAL_STORAGE_DIR, String(documentId));
  await rm(targetDir, { recursive: true, force: true });
}