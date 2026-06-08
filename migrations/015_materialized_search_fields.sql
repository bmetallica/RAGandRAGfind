CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS search_lookup_normalized TEXT GENERATED ALWAYS AS (
    lower(regexp_replace(COALESCE(title, '') || ' ' || COALESCE(source_ref, ''), '[^[:alnum:]]+', ' ', 'g'))
  ) STORED,
  ADD COLUMN IF NOT EXISTS search_text_normalized_preview TEXT GENERATED ALWAYS AS (
    lower(regexp_replace(left(COALESCE(extracted_text, ''), 16000), '[^[:alnum:]]+', ' ', 'g'))
  ) STORED,
  ADD COLUMN IF NOT EXISTS search_lookup_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', COALESCE(title, '')), 'A')
    || setweight(to_tsvector('simple', COALESCE(source_ref, '')), 'B')
  ) STORED;

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS search_content_normalized TEXT GENERATED ALWAYS AS (
    lower(regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))
  ) STORED,
  ADD COLUMN IF NOT EXISTS search_content_tsv TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', content)
  ) STORED;

ALTER TABLE document_sections
  ADD COLUMN IF NOT EXISTS search_title_normalized TEXT GENERATED ALWAYS AS (
    lower(regexp_replace(COALESCE(title, ''), '[^[:alnum:]]+', ' ', 'g'))
  ) STORED,
  ADD COLUMN IF NOT EXISTS search_content_normalized TEXT GENERATED ALWAYS AS (
    lower(regexp_replace(content, '[^[:alnum:]]+', ' ', 'g'))
  ) STORED,
  ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', COALESCE(title, '')), 'A')
    || setweight(to_tsvector('simple', content), 'B')
  ) STORED;

DROP INDEX IF EXISTS idx_documents_lookup_tsv;
DROP INDEX IF EXISTS idx_documents_lookup_trgm;
DROP INDEX IF EXISTS idx_document_chunks_content_tsv;

CREATE INDEX IF NOT EXISTS idx_documents_search_lookup_tsv
  ON documents USING GIN (search_lookup_tsv);

CREATE INDEX IF NOT EXISTS idx_documents_search_lookup_trgm
  ON documents USING GIN (search_lookup_normalized gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_document_chunks_search_content_tsv
  ON document_chunks USING GIN (search_content_tsv);

CREATE INDEX IF NOT EXISTS idx_document_sections_search_tsv
  ON document_sections USING GIN (search_tsv);