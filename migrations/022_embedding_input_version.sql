-- Tracks WHICH input text a stored vector was produced from, next to the
-- existing embedding_model / embedding_dimension columns.
--
-- Since migration 022 the embedding input is no longer the raw chunk content:
-- it carries a document/section context header and a model-specific task
-- prefix (see src/services/embeddingInputService.ts). Changing that shape
-- invalidates every stored vector even though the model name stays the same,
-- which the model-name comparison in ReembeddingService cannot detect on its
-- own. NULL means "produced before this column existed", i.e. version 1.

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS embedding_input_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_input_version
  ON document_chunks (embedding_input_version)
  WHERE embedding IS NOT NULL;
