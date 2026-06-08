import { pool } from "../db/pool";
import { logger } from "../utils/logger";
import { VectorService } from "./vectorService";

export interface ReembedOptions {
  targetModel: string;
  targetDimension: number;
  batchSize?: number;
}

interface ChunkRow {
  id: number;
  content: string;
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

    const totalResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM document_chunks WHERE embedding_model != $1`,
      [options.targetModel]
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    let processed = 0;

    for (;;) {
      const batch = await pool.query<ChunkRow>(
        `
          SELECT id, content
          FROM document_chunks
          WHERE embedding_model != $1
          ORDER BY id ASC
          LIMIT $2
        `,
        [options.targetModel, batchSize]
      );

      if (batch.rowCount === 0) {
        break;
      }

      const embeddings = await this.vectorService.embed(
        batch.rows.map((row) => row.content),
        options.targetModel
      );

      for (const [index, row] of batch.rows.entries()) {
        await pool.query(
          `
            UPDATE document_chunks
            SET embedding = $1::vector, embedding_model = $2, embedding_dimension = $3
            WHERE id = $4
          `,
          [`[${embeddings[index].join(",")}]`, options.targetModel, options.targetDimension, row.id]
        );
      }

      processed += batch.rowCount ?? batch.rows.length;
      logger.info({ processed, total, targetModel: options.targetModel }, "re-embedding progress");
    }

    return { processed, total };
  }
}
