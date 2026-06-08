ALTER TABLE document_type_settings
  ADD COLUMN IF NOT EXISTS chunk_size INTEGER,
  ADD COLUMN IF NOT EXISTS chunk_overlap INTEGER;
