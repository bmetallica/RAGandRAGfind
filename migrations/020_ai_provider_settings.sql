CREATE TABLE IF NOT EXISTS ai_provider_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  provider TEXT NOT NULL DEFAULT 'ollama' CHECK (provider IN ('ollama', 'openai')),
  base_url TEXT NOT NULL,
  api_key TEXT,
  embedding_model TEXT NOT NULL,
  summary_model TEXT NOT NULL,
  classifier_model TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
