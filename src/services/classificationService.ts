import { pool } from "../db/pool";
import { inferDocumentType } from "./documentService";
import { logger } from "../utils/logger";
import { searchIndexService } from "./searchIndexService";
import { requestGeneration } from "./aiProviderClient";
import { getAiProviderConnection, getClassifierModelName } from "./aiProviderSettingsService";
import {
  ensureDocumentTypeSettingsLoaded,
  getEnabledDocumentTypeSettingsSnapshot,
  normalizeDocumentTypeKey
} from "./documentTypeRegistryService";

type DocumentType = string;
type ClassificationConfidence = "low" | "medium" | "high";

interface ClassificationResult {
  documentType: DocumentType;
  confidence: ClassificationConfidence;
  summary: string;
  rationale: string;
  traits: string[];
  model: string;
  baseUrl: string;
}

interface ClassificationBackfillRow {
  id: number;
  title: string | null;
  source_ref: string;
  source_type: string;
  file_type: string | null;
  extracted_text: string;
  metadata: Record<string, unknown> | null;
}

export interface ClassificationBackfillResult {
  processed: number;
  classified: number;
  skipped: number;
  failed: number;
}

interface ClassifiableDocumentRow extends ClassificationBackfillRow {}

function normalizeConfidence(value: unknown): ClassificationConfidence {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  return "medium";
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const startIndex = candidate.indexOf("{");
  const endIndex = candidate.lastIndexOf("}");
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error("classifier did not return a JSON object");
  }

  return JSON.parse(candidate.slice(startIndex, endIndex + 1)) as Record<string, unknown>;
}

export class DocumentClassificationService {
  private async loadDocumentForClassification(documentId: number): Promise<ClassifiableDocumentRow | null> {
    const result = await pool.query<ClassifiableDocumentRow>(
      `
        SELECT id, title, source_ref, source_type, file_type, extracted_text, metadata
        FROM documents
        WHERE id = $1
          AND COALESCE(extracted_text, '') <> ''
        LIMIT 1
      `,
      [documentId]
    );

    return result.rows[0] ?? null;
  }

  private async classifyStoredDocument(row: ClassifiableDocumentRow): Promise<Record<string, unknown>> {
    const existingMetadata = row.metadata ?? {};
    const fallbackDocumentType = inferDocumentType({
      title: row.title,
      sourceRef: row.source_ref,
      sourceType: row.source_type,
      fileType: row.file_type,
      metadata: existingMetadata
    });

    const classification = await this.classifyDocument({
      title: row.title,
      sourceRef: row.source_ref,
      sourceType: row.source_type,
      fileType: row.file_type,
      text: row.extracted_text,
      fallbackDocumentType
    });

    return this.buildClassificationMetadata(existingMetadata, classification);
  }

  buildClassificationMetadata(
    existingMetadata: Record<string, unknown> | null | undefined,
    classification: ClassificationResult
  ): Record<string, unknown> {
    return {
      ...(existingMetadata ?? {}),
      documentType: classification.documentType,
      classification: {
        confidence: classification.confidence,
        summary: classification.summary,
        rationale: classification.rationale,
        traits: classification.traits,
        model: classification.model,
        baseUrl: classification.baseUrl,
        classifiedAt: new Date().toISOString()
      }
    };
  }

  async classifyDocument(input: {
    title?: string | null;
    sourceRef: string;
    sourceType: string;
    fileType?: string | null;
    text: string;
    fallbackDocumentType: string;
  }): Promise<ClassificationResult> {
    await ensureDocumentTypeSettingsLoaded();
    const connection = await getAiProviderConnection();
    const model = await getClassifierModelName();
    const excerpt = input.text.slice(0, 12_000);
    const enabledDocumentTypes = getEnabledDocumentTypeSettingsSnapshot();
    const allowedDocumentTypes = enabledDocumentTypes.map((setting) => setting.key);
    const documentTypeHints = enabledDocumentTypes
      .filter((setting) => setting.key !== "generic")
      .map((setting) => `- ${setting.key}: ${setting.promptHint || setting.description}`)
      .join("\n");
    const prompt = [
      "You classify ingested documents for a RAG system.",
      `Allowed documentType values: ${allowedDocumentTypes.join(", ")}.`,
      'Return JSON only with this schema: {"documentType":"...","confidence":"low|medium|high","summary":"...","rationale":"...","traits":["..."]}.',
      "Choose the single best documentType from the allowed list.",
      "Keep summary and rationale short and factual.",
      `Fallback documentType if uncertain: ${input.fallbackDocumentType}.`,
      "Type guidance:",
      documentTypeHints,
      "",
      `title: ${input.title ?? ""}`,
      `sourceRef: ${input.sourceRef}`,
      `sourceType: ${input.sourceType}`,
      `fileType: ${input.fileType ?? ""}`,
      "",
      "document excerpt:",
      excerpt
    ].join("\n");

    const raw = await requestGeneration(connection, prompt, model, { jsonResponse: true, timeoutMs: 90_000 });
    const parsed = extractJsonObject(raw);
    const documentType = normalizeDocumentTypeKey(parsed.documentType, normalizeDocumentTypeKey(input.fallbackDocumentType, "generic"));
    const traits = Array.isArray(parsed.traits)
      ? parsed.traits.map((value) => String(value).trim()).filter(Boolean).slice(0, 8)
      : [];

    return {
      documentType,
      confidence: normalizeConfidence(parsed.confidence),
      summary: typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 400) : "",
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.trim().slice(0, 400) : "",
      traits,
      model,
      baseUrl: connection.baseUrl
    };
  }

  async backfillDocuments(options?: {
    batchSize?: number;
    maxDocuments?: number;
    force?: boolean;
  }): Promise<ClassificationBackfillResult> {
    const batchSize = Math.max(1, Math.min(options?.batchSize ?? 25, 200));
    const maxDocuments = typeof options?.maxDocuments === "number" && Number.isFinite(options.maxDocuments) && options.maxDocuments > 0
      ? Math.max(1, Math.min(options.maxDocuments, 10_000))
      : null;
    const force = Boolean(options?.force);

    let processed = 0;
    let classified = 0;
    let skipped = 0;
    let failed = 0;
    let lastDocumentId = 0;

    while (maxDocuments === null || processed < maxDocuments) {
      const remaining = maxDocuments === null ? batchSize : Math.min(batchSize, maxDocuments - processed);
      if (remaining <= 0) {
        break;
      }

      const result = await pool.query<ClassificationBackfillRow>(
        `
          SELECT id, title, source_ref, source_type, file_type, extracted_text, metadata
          FROM documents
          WHERE id > $1
            AND COALESCE(extracted_text, '') <> ''
          ORDER BY id ASC
          LIMIT $2
        `,
        [lastDocumentId, remaining]
      );

      if (!result.rows.length) {
        break;
      }

      for (const row of result.rows) {
        processed += 1;
        lastDocumentId = row.id;

        const existingMetadata = row.metadata ?? {};
        const hasExistingClassification = typeof existingMetadata.documentType === "string" && typeof (existingMetadata.classification as Record<string, unknown> | undefined)?.model === "string";
        if (hasExistingClassification && !force) {
          skipped += 1;
          continue;
        }

        try {
          const metadata = await this.classifyStoredDocument(row);
          await pool.query(
            `
              UPDATE documents
              SET metadata = $2,
                  updated_at = NOW()
              WHERE id = $1
            `,
            [row.id, JSON.stringify(metadata)]
          );

          classified += 1;

          if (searchIndexService.isEnabled()) {
            try {
              await searchIndexService.syncDocument(row.id);
            } catch (error) {
              logger.warn({ err: error, documentId: row.id }, "failed to sync document to elasticsearch after classification backfill");
            }
          }
        } catch (error) {
          failed += 1;
          logger.warn({ err: error, documentId: row.id, sourceRef: row.source_ref }, "failed document classification backfill");
        }
      }
    }

    if (classified > 0 && searchIndexService.isEnabled()) {
      await searchIndexService.refreshIndices().catch((error) => {
        logger.warn({ err: error }, "failed to refresh elasticsearch indices after classification backfill");
      });
    }

    return { processed, classified, skipped, failed };
  }

  async reclassifyDocument(documentId: number): Promise<{ documentId: number; metadata: Record<string, unknown> } | null> {
    const row = await this.loadDocumentForClassification(documentId);
    if (!row) {
      return null;
    }

    const metadata = await this.classifyStoredDocument(row);
    await pool.query(
      `
        UPDATE documents
        SET metadata = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [documentId, JSON.stringify(metadata)]
    );

    if (searchIndexService.isEnabled()) {
      try {
        await searchIndexService.syncDocument(documentId);
        await searchIndexService.refreshIndices();
      } catch (error) {
        logger.warn({ err: error, documentId }, "failed to sync document to elasticsearch after single reclassification");
      }
    }

    return {
      documentId,
      metadata
    };
  }
}