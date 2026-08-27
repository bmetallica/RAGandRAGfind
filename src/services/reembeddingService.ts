import { pool } from "../db/pool";
import { logger } from "../utils/logger";
import { VectorService } from "./vectorService";
import { EMBEDDING_INPUT_VERSION, buildDocumentEmbeddingInput } from "./embeddingInputService";

export interface ReembedOptions {
  targetModel: string;
  targetDimension: number;
  batchSize?: number;
  // Also re-embed chunks that already carry `targetModel` but were produced
  // from an older embedding input shape. Needed whenever the input changes
  // without the model changing - the model-name comparison alone would then
  // find nothing to do. See EMBEDDING_INPUT_VERSION.
  force?: boolean;
}

interface ChunkRow {
  id: number;
  content: string;
  document_title: string | null;
  section_title: string | null;
}

const DEFAULT_BATCH_SIZE = 50;

// Re-embeds chunks that were created with a different embedding model.
// Runs in batches against `vectorService.embed`, which is gated by the
// shared Ollama concurrency semaphore - safe to run alongside live ingestion.
//
// Important: if `targetDimension` differs from the current `embedding` column
// dimension, run `ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(n)`
// manually beforehand. pgvector does not support a variable dimension per column,
// so this service intentionally does not attempt that migration automatically.
export class ReembeddingService {
  constructor(private readonly vectorService = new VectorService()) {}

  async run(options: ReembedOptions): Promise<{ processed: number; total: number }> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

    const force = options.force === true;
    // In force mode a chunk is stale when EITHER the model or the input version
    // is out of date; otherwise only a model change counts, as before.
    const staleCondition = force
      ? `(c.embedding_model != $1 OR COALESCE(c.embedding_input_version, 1) != ${EMBEDDING_INPUT_VERSION})`
      : "c.embedding_model != $1";

    const totalResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM document_chunks c WHERE ${staleCondition}`,
      [options.targetModel]
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    let processed = 0;

    for (;;) {
      const batch = await pool.query<ChunkRow>(
        `
          SELECT
            c.id,
            c.content,
            d.title AS document_title,
            s.title AS section_title
          FROM document_chunks c
          INNER JOIN documents d ON d.id = c.document_id
          LEFT JOIN document_sections s ON s.id = c.document_section_id
          WHERE ${staleCondition}
          ORDER BY c.id ASC
          LIMIT $2
        `,
        [options.targetModel, batchSize]
      );

      if (batch.rowCount === 0) {
        break;
      }

      // Same input construction as the ingestion path (EmbeddingPendingService),
      // otherwise a re-embedded chunk would end up with a different vector than
      // a freshly ingested one.
      const embeddings = await this.vectorService.embedDocuments(
        batch.rows.map((row) => buildDocumentEmbeddingInput({
          documentTitle: row.document_title,
          sectionTitle: row.section_title,
          content: row.content
        })),
        options.targetModel
      );

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
            options.targetModel,
            options.targetDimension,
            EMBEDDING_INPUT_VERSION,
            row.id
          ]
        );
      }

      processed += batch.rowCount ?? batch.rows.length;
      logger.info({ processed, total, targetModel: options.targetModel, force }, "re-embedding progress");
    }

    return { processed, total };
  }
}
