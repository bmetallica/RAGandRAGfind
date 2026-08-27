import { pool } from "../db/pool";
import { logger } from "../utils/logger";
import { VectorService } from "./vectorService";
import { getAiProviderSettings } from "./aiProviderSettingsService";
import { EMBEDDING_INPUT_VERSION, buildDocumentEmbeddingInput } from "./embeddingInputService";

interface PendingChunkRow {
  id: number;
  content: string;
  document_title: string | null;
  section_title: string | null;
}

const DEFAULT_BATCH_SIZE = 50;

// Embeds chunks that were persisted with `embedding_status = 'pending'` by the
// async ingestion pipeline (see IngestionService - embedding is intentionally
// decoupled from the ingestion transaction so a slow/unreachable Ollama can
// never hold a DB transaction open or block ingestion). Mirrors
// ReembeddingService's batch-loop pattern; `vectorService.embed` already
// provides the shared concurrency semaphore, Ollama health-check, and
// indefinite retry-on-transient-failure (see VectorService.embedWithRetry).
export class EmbeddingPendingService {
  constructor(private readonly vectorService = new VectorService()) {}

  async run(batchSize = DEFAULT_BATCH_SIZE): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;

    for (;;) {
      // Title and section heading come along so the embedding input can carry
      // them as a context header (see buildDocumentEmbeddingInput). They are NOT
      // written back into `content` - only the vector sees them.
      const batch = await pool.query<PendingChunkRow>(
        `
          SELECT
            c.id,
            c.content,
            d.title AS document_title,
            s.title AS section_title
          FROM document_chunks c
          INNER JOIN documents d ON d.id = c.document_id
          LEFT JOIN document_sections s ON s.id = c.document_section_id
          WHERE c.embedding_status = 'pending'
          ORDER BY c.id ASC
          LIMIT $1
        `,
        [batchSize]
      );

      if (batch.rowCount === 0) {
        break;
      }

      const aiProviderSettings = await getAiProviderSettings();

      let embeddings: number[][];
      try {
        embeddings = await this.vectorService.embedDocuments(
          batch.rows.map((row) => buildDocumentEmbeddingInput({
            documentTitle: row.document_title,
            sectionTitle: row.section_title,
            content: row.content
          }))
        );
      } catch (error) {
        // A permanent/configuration error (dimension or count mismatch) -
        // vectorService already exhausted the transient-retry path before
        // throwing this (see embedWithRetry's axios.isAxiosError check).
        // Mark the batch as failed so it stops blocking the queue and surfaces
        // as "needs attention" in the UI, instead of looping on the same
        // unrecoverable batch forever.
        const reason = error instanceof Error ? error.message : String(error);
        logger.error(
          { err: error, chunkIds: batch.rows.map((row) => row.id) },
          "embedding failed permanently for batch; marking chunks as failed"
        );

        await pool.query(
          `
            UPDATE document_chunks
            SET embedding_status = 'failed',
                metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{embeddingError}', to_jsonb($2::text))
            WHERE id = ANY($1::bigint[])
          `,
          [batch.rows.map((row) => row.id), reason]
        );

        failed += batch.rowCount ?? batch.rows.length;
        continue;
      }

      for (const [index, row] of batch.rows.entries()) {
        await pool.query(
          `
            UPDATE document_chunks
            SET embedding = $1::vector,
                embedding_status = 'completed',
                embedding_model = $2,
                embedding_dimension = $3,
                embedding_input_version = $4
            WHERE id = $5
          `,
          [
            `[${embeddings[index].join(",")}]`,
            aiProviderSettings.embeddingModel,
            aiProviderSettings.embeddingDimension,
            EMBEDDING_INPUT_VERSION,
            row.id
          ]
        );
      }

      processed += batch.rowCount ?? batch.rows.length;
      logger.info({ processed, failed }, "pending-embedding progress");
    }

    return { processed, failed };
  }
}
