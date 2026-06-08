ALTER TABLE document_chunks
  ALTER COLUMN embedding DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE document_chunks
  DROP CONSTRAINT IF EXISTS document_chunks_embedding_status_check;

ALTER TABLE document_chunks
  ADD CONSTRAINT document_chunks_embedding_status_check
  CHECK (embedding_status IN ('pending', 'completed', 'failed')) NOT VALID;

UPDATE document_chunks SET embedding_status = 'completed' WHERE embedding IS NOT NULL;
UPDATE document_chunks SET embedding_status = 'pending' WHERE embedding IS NULL AND embedding_status = 'completed';

ALTER TABLE document_chunks VALIDATE CONSTRAINT document_chunks_embedding_status_check;

CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_pending
  ON document_chunks (id) WHERE embedding_status != 'completed';
