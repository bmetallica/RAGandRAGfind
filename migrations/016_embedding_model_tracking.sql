ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER;

UPDATE document_chunks
SET embedding_model = 'nomic-embed-text', embedding_dimension = 768
WHERE embedding_model IS NULL;

ALTER TABLE document_chunks
  ALTER COLUMN embedding_model SET NOT NULL,
  ALTER COLUMN embedding_dimension SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_model
  ON document_chunks (embedding_model);
