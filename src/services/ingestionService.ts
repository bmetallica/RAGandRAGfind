import path from "node:path";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { ExtractorService } from "./extractorService";
import { normalizeDocumentText, smartChunkText } from "../utils/chunking";
import { sha256 } from "../utils/hash";
import { inferDocumentType, persistDocumentStructure } from "./documentService";
import { getDocumentTypeSettingByKey } from "./documentTypeRegistryService";
import { upsertDocumentFile } from "./originalFileService";
import { logger } from "../utils/logger";
import { searchIndexService } from "./searchIndexService";
import { embedPendingQueue } from "../queues";
import { DocumentClassificationService } from "./classificationService";
import { getAiProviderSettings } from "./aiProviderSettingsService";

export interface IngestTextInput {
  sourceType: string;
  sourceRef: string;
  knowledgeBaseId?: number | null;
  sourceUrl?: string;
  title?: string;
  text: string;
  mimeType?: string;
  fileType?: string;
  metadata?: Record<string, unknown>;
  originalFilePath?: string;
  originalFileName?: string;
  originalExternalUrl?: string;
}

export interface IngestFileInput {
  filePath: string;
  sourceType: string;
  sourceRef: string;
  knowledgeBaseId?: number | null;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
}

function sanitizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.replace(/\u0000/g, "");
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\u0000/g, "");
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknown(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeUnknown(entry)])
    );
  }

  return value;
}

export class IngestionService {
  constructor(
    private readonly extractorService = new ExtractorService(),
    private readonly classificationService = new DocumentClassificationService()
  ) {}

  async ingestFile(input: IngestFileInput) {
    const extracted = await this.extractorService.extract(input.filePath);
    const uploadedFileName = typeof input.metadata?.uploadedFileName === "string"
      ? input.metadata.uploadedFileName
      : null;
    const sourceRefName = input.sourceType === "crawl-file"
      ? this.getUrlFileName(input.sourceRef)
      : path.basename(input.sourceRef);

    return this.ingestText({
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      knowledgeBaseId: input.knowledgeBaseId ?? null,
      sourceUrl: input.sourceUrl,
      title: extracted.title,
      text: extracted.text,
      mimeType: extracted.mimeType,
      fileType: extracted.fileType,
      originalFilePath: input.filePath,
      originalFileName: uploadedFileName || sourceRefName || path.basename(input.filePath),
      originalExternalUrl: input.sourceUrl,
      metadata: {
        ...(input.metadata ?? {}),
        usedOcr: extracted.usedOcr,
        filePath: input.filePath
      }
    });
  }

  async ingestText(input: IngestTextInput): Promise<{ documentId: number; duplicate: boolean; chunkCount: number }> {
    const normalizedText = normalizeDocumentText(input.text);
    if (!normalizedText) {
      throw new Error(`no text extracted for ${input.sourceRef}`);
    }

    const sanitizedSourceType = sanitizeString(input.sourceType) ?? input.sourceType;
    const sanitizedSourceRef = sanitizeString(input.sourceRef) ?? input.sourceRef;
    const sanitizedSourceUrl = sanitizeString(input.sourceUrl);
    const sanitizedTitle = sanitizeString(input.title);
    const sanitizedMimeType = sanitizeString(input.mimeType);
    const sanitizedFileType = sanitizeString(input.fileType);
    const sanitizedOriginalFileName = sanitizeString(input.originalFileName);
    const sanitizedOriginalExternalUrl = sanitizeString(input.originalExternalUrl);
    const sanitizedMetadata = sanitizeUnknown(input.metadata ?? {}) as Record<string, unknown>;

    const contentHash = sha256(normalizedText);

    // Die Suche darf NICHT auf die Wissensdatenbank eingeschraenkt werden:
    // documents.content_hash ist global eindeutig. Mit der Einschraenkung fand
    // ein Lauf, der dasselbe Dokument ohne oder mit anderer Wissensdatenbank
    // aufnahm, den Bestand nicht - und lief in eine Verletzung der Eindeutigkeit
    // statt in den Duplikatpfad. Der ganze Crawl brach dann ab, und der
    // Nachtrag der fehlenden Originaldatei kam nie zustande.
    const preflightExisting = await pool.query<{ id: number }>(
      `
        SELECT id
        FROM documents
        WHERE content_hash = $1
        ORDER BY (COALESCE(knowledge_base_id, 0) = COALESCE($2::bigint, 0)) DESC, id ASC
        LIMIT 1
      `,
      [contentHash, input.knowledgeBaseId ?? null]
    );
    if (preflightExisting.rowCount) {
      const existingId = preflightExisting.rows[0].id;
      // Inhaltlich unveraendert, aber vielleicht fehlt die Originaldatei: bei
      // Dokumenten aus der Zeit vor deren Speicherung, oder wenn die Datei
      // damals nicht erreichbar war. Ohne diesen Nachtrag koennte ein erneuter
      // Durchlauf das nie heilen - er bricht hier ab, bevor die Datei angehaengt
      // wird, und liefert nur "duplicate".
      await this.attachMissingOriginalFile(existingId, {
        originalFilePath: input.originalFilePath,
        originalFileName: sanitizedOriginalFileName,
        originalExternalUrl: sanitizedOriginalExternalUrl ?? sanitizedSourceUrl,
        sourceType: sanitizedSourceType,
        sourceRef: sanitizedSourceRef,
        mimeType: sanitizedMimeType,
        title: sanitizedTitle
      });

      return { documentId: existingId, duplicate: true, chunkCount: 0 };
    }

    const heuristicDocumentType = inferDocumentType({
      title: sanitizedTitle,
      sourceRef: sanitizedSourceRef,
      sourceType: sanitizedSourceType,
      fileType: sanitizedFileType,
      metadata: sanitizedMetadata
    });

    // Classification runs before chunking now: its result (grounded in the
    // actual extracted/OCR'd text, unlike the metadata-only heuristic) drives
    // both the stored document type AND the chunk parameters below - so e.g. a
    // generically-named OCR'd scientific PDF still gets book-appropriate
    // chunking instead of silently falling back to "generic" sizing.
    let classificationMetadata: Record<string, unknown> | null = null;
    let resolvedDocumentType = heuristicDocumentType;
    try {
      const classification = await this.classificationService.classifyDocument({
        title: sanitizedTitle,
        sourceRef: sanitizedSourceRef,
        sourceType: sanitizedSourceType,
        fileType: sanitizedFileType,
        text: normalizedText,
        fallbackDocumentType: heuristicDocumentType
      });

      classificationMetadata = this.classificationService.buildClassificationMetadata(sanitizedMetadata, classification);
      resolvedDocumentType = classification.documentType;
    } catch (error) {
      logger.warn({ err: error, sourceRef: sanitizedSourceRef }, "document classification failed; falling back to heuristic document type");
      classificationMetadata = {
        documentType: heuristicDocumentType
      };
    }

    const documentMetadata = sanitizeUnknown({
      ...(classificationMetadata ?? {})
    }) as Record<string, unknown>;

    const documentTypeSetting = getDocumentTypeSettingByKey(resolvedDocumentType);
    const chunkSize = documentTypeSetting?.chunkingSettings.chunkSize ?? env.CHUNK_SIZE;
    const overlap = documentTypeSetting?.chunkingSettings.overlap ?? env.CHUNK_OVERLAP;
    const chunks = smartChunkText(normalizedText, { chunkSize, overlap });

    if (chunks.length === 0) {
      throw new Error(`chunking produced no output for ${input.sourceRef}`);
    }

    const client = await pool.connect();
    let committedDocumentId: number | null = null;
    let duplicateDocumentId: number | null = null;
    let committedChunkCount = 0;
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ id: number }>(
        `
          SELECT id
          FROM documents
          WHERE content_hash = $1
          ORDER BY (COALESCE(knowledge_base_id, 0) = COALESCE($2::bigint, 0)) DESC, id ASC
          LIMIT 1
        `,
        [contentHash, input.knowledgeBaseId ?? null]
      );
      if (existing.rowCount) {
        await client.query("COMMIT");
        duplicateDocumentId = existing.rows[0].id;
        // Wie oben im Vorab-Check - hier greift der Fall, wenn zwei Ingests
        // parallel dasselbe Dokument sehen.
        await this.attachMissingOriginalFile(duplicateDocumentId, {
          originalFilePath: input.originalFilePath,
          originalFileName: sanitizedOriginalFileName,
          originalExternalUrl: sanitizedOriginalExternalUrl ?? sanitizedSourceUrl,
          sourceType: sanitizedSourceType,
          sourceRef: sanitizedSourceRef,
          mimeType: sanitizedMimeType,
          title: sanitizedTitle
        });
        return { documentId: duplicateDocumentId, duplicate: true, chunkCount: 0 };
      }

      const documentInsert = await client.query<{ id: number }>(
        `
          INSERT INTO documents (
            source_type,
            source_ref,
            source_url,
            title,
            knowledge_base_id,
            content_hash,
            mime_type,
            file_type,
            extracted_text,
            metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `,
        [
          sanitizedSourceType,
          sanitizedSourceRef,
          sanitizedSourceUrl,
          sanitizedTitle,
          input.knowledgeBaseId ?? null,
          contentHash,
          sanitizedMimeType,
          sanitizedFileType,
          normalizedText,
          JSON.stringify(documentMetadata)
        ]
      );

      const documentId = documentInsert.rows[0].id;
      committedDocumentId = documentId;
      const aiProviderSettings = await getAiProviderSettings();
      // Chunks are persisted WITHOUT embeddings - embedding happens out-of-band
      // in the embed-pending worker (see EmbeddingPendingService), triggered
      // below right after COMMIT. This keeps the transaction short (no Ollama
      // round-trip held open) and makes the document immediately searchable via
      // full-text/trigram search; vector search "catches up" once embedding
      // completes. It also means a slow/unreachable Ollama can never block
      // ingestion or exhaust the connection pool.
      for (const chunk of chunks) {
        await client.query(
          `
            INSERT INTO document_chunks (
              document_id,
              document_section_id,
              chunk_index,
              content,
              token_estimate,
              start_offset,
              end_offset,
              metadata,
              embedding,
              embedding_status,
              embedding_model,
              embedding_dimension
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 'pending', $9, $10)
          `,
          [
            documentId,
            null,
            chunk.chunkIndex,
            chunk.content,
            chunk.tokenEstimate,
            chunk.startOffset,
            chunk.endOffset,
            JSON.stringify({
              ...documentMetadata,
              chunkIndex: chunk.chunkIndex,
              startOffset: chunk.startOffset,
              endOffset: chunk.endOffset
            }),
            aiProviderSettings.embeddingModel,
            aiProviderSettings.embeddingDimension
          ]
        );
      }

      await persistDocumentStructure(client, {
        documentId,
        text: normalizedText
      });

      if (input.originalFilePath || input.originalExternalUrl || input.sourceUrl) {
        await upsertDocumentFile(client, documentId, {
          localPath: input.originalFilePath,
          externalUrl: sanitizedOriginalExternalUrl ?? sanitizedSourceUrl,
          originalName: sanitizedOriginalFileName ?? sanitizedTitle ?? sanitizedSourceRef,
          mimeType: sanitizedMimeType,
          metadata: {
            ...documentMetadata,
            sourceType: sanitizedSourceType,
            sourceRef: sanitizedSourceRef
          }
        });
      }

      await client.query("COMMIT");
      committedChunkCount = chunks.length;
      void embedPendingQueue.add("embed-pending", {}).catch((error) => {
        logger.warn({ err: error, documentId }, "failed to enqueue pending-embedding job after ingestion");
      });
      return { documentId, duplicate: false, chunkCount: chunks.length };
    } catch (error) {
      await client.query("ROLLBACK");

      // Zwei Laeufe koennen dasselbe Dokument gleichzeitig sehen; der zweite
      // laeuft dann trotz aller Vorabpruefungen in die Eindeutigkeit von
      // content_hash. Das ist ein Duplikat, kein Fehlschlag - ohne diesen Zweig
      // bricht ein ganzer Crawl an einer bereits bekannten Seite ab.
      if ((error as { code?: string }).code === "23505") {
        const existingByHash = await pool.query<{ id: number }>(
          "SELECT id FROM documents WHERE content_hash = $1 LIMIT 1",
          [contentHash]
        );
        if (existingByHash.rowCount) {
          duplicateDocumentId = existingByHash.rows[0].id;
          await this.attachMissingOriginalFile(duplicateDocumentId, {
            originalFilePath: input.originalFilePath,
            originalFileName: sanitizedOriginalFileName,
            originalExternalUrl: sanitizedOriginalExternalUrl ?? sanitizedSourceUrl,
            sourceType: sanitizedSourceType,
            sourceRef: sanitizedSourceRef,
            mimeType: sanitizedMimeType,
            title: sanitizedTitle
          });
          logger.info({ documentId: duplicateDocumentId, sourceRef: sanitizedSourceRef }, "ingestion hit an existing content hash and was treated as duplicate");
          return { documentId: duplicateDocumentId, duplicate: true, chunkCount: 0 };
        }
      }

      throw error;
    } finally {
      client.release();

      const documentIdToSync = committedDocumentId ?? duplicateDocumentId;
      if (documentIdToSync && searchIndexService.isEnabled()) {
        void searchIndexService.syncDocument(documentIdToSync).catch((error) => {
          logger.warn({ err: error, documentId: documentIdToSync }, "failed to sync document to elasticsearch after ingestion");
        });
      }
    }
  }

  // Haengt einem bereits vorhandenen Dokument die Originaldatei nachtraeglich an,
  // aber nur wenn dort noch keine lokale Kopie liegt. Eine vorhandene Kopie wird
  // nie ersetzt: der gespeicherte Inhalt gehoert zum Textstand des Dokuments.
  private async attachMissingOriginalFile(
    documentId: number,
    input: {
      originalFilePath?: string;
      originalFileName: string | null;
      originalExternalUrl: string | null;
      sourceType: string;
      sourceRef: string;
      mimeType: string | null;
      title: string | null;
    }
  ): Promise<void> {
    if (!input.originalFilePath) {
      return;
    }

    try {
      const existingFile = await pool.query<{ relative_path: string | null }>(
        "SELECT relative_path FROM document_files WHERE document_id = $1 LIMIT 1",
        [documentId]
      );
      if (existingFile.rows[0]?.relative_path) {
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await upsertDocumentFile(client, documentId, {
          localPath: input.originalFilePath,
          externalUrl: input.originalExternalUrl,
          originalName: input.originalFileName ?? input.title ?? input.sourceRef,
          mimeType: input.mimeType,
          metadata: {
            sourceType: input.sourceType,
            sourceRef: input.sourceRef,
            attachedLater: true
          }
        });
        await client.query("COMMIT");
        logger.info({ documentId }, "attached a missing original file to an existing document");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      // Das Dokument selbst ist in Ordnung - ein fehlgeschlagener Nachtrag darf
      // die Ingestion nicht scheitern lassen.
      logger.warn({ err: error, documentId }, "failed to attach a missing original file to an existing document");
    }
  }

  private getUrlFileName(value: string): string | null {
    try {
      const url = new URL(value);
      const fileName = path.basename(url.pathname);
      return fileName || null;
    } catch {
      return null;
    }
  }
}
