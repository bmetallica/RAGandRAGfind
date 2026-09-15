-- German text search alongside the existing 'simple' configuration.
--
-- The 'simple' vectors from migration 015 index raw tokens: "Dienstpläne" and
-- "Dienstplan" are unrelated terms there, which is wrong for a German corpus.
-- The 'german' configuration adds Snowball stemming and German stop words.
--
-- These columns are ADDED, not replaced. 'simple' stays because it is the only
-- thing that matches file names, Aktenzeichen, article numbers and identifiers
-- exactly - the German stemmer would mangle those. Queries match against both
-- and take the better of the two ranks (see executeSimilarityQuery).
--
-- `to_tsvector('german', ...)` with a literal configuration name is IMMUTABLE
-- and therefore valid in a generated column. `unaccent()` is only STABLE and is
-- deliberately not used here; the German Snowball stemmer already folds umlauts.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS search_lookup_tsv_de TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('german', COALESCE(title, '')), 'A')
    || setweight(to_tsvector('german', COALESCE(source_ref, '')), 'B')
  ) STORED;

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS search_content_tsv_de TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('german', content)
  ) STORED;

ALTER TABLE document_sections
  ADD COLUMN IF NOT EXISTS search_tsv_de TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('german', COALESCE(title, '')), 'A')
    || setweight(to_tsvector('german', content), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_documents_search_lookup_tsv_de
  ON documents USING GIN (search_lookup_tsv_de);

CREATE INDEX IF NOT EXISTS idx_document_chunks_search_content_tsv_de
  ON document_chunks USING GIN (search_content_tsv_de);

CREATE INDEX IF NOT EXISTS idx_document_sections_search_tsv_de
  ON document_sections USING GIN (search_tsv_de);
