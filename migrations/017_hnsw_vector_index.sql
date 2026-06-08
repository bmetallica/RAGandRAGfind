DROP INDEX IF EXISTS idx_document_chunks_embedding;

CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_hnsw
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Note: at much larger row counts than today, build this with
-- `CREATE INDEX CONCURRENTLY` in a standalone script (it cannot run inside
-- a transaction block, so it does not fit the simple migration runner).
