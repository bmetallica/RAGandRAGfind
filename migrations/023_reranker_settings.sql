-- Cross-encoder reranker configuration, stored next to the AI provider settings
-- and managed from the Config-AI admin view.
--
-- Kept as separate columns rather than reusing base_url/model: the reranker
-- usually runs as its own server (llama.cpp with --reranking, TEI, Infinity,
-- vLLM) on a different port than the embedding/LLM provider, and it must be
-- switchable off on its own without touching the rest of the configuration.

ALTER TABLE ai_provider_settings
  ADD COLUMN IF NOT EXISTS reranker_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reranker_base_url TEXT,
  ADD COLUMN IF NOT EXISTS reranker_model TEXT,
  -- How many of the top candidates are handed to the cross-encoder. Everything
  -- below that keeps its fusion rank - reranking the whole candidate set would
  -- cost latency for positions nobody reads.
  --
  -- The default is deliberately modest. Reranking cost is linear in the number
  -- of documents sent: measured against Qwen3-Reranker-0.6B on llama.cpp at
  -- ~1200 characters per document, 8 candidates took ~740 ms, 12 ~1090 ms and
  -- 20 ~1800 ms - so 20 would roughly triple a search that otherwise takes
  -- 300-800 ms. Raise it once an eval run shows the extra recall is worth it.
  ADD COLUMN IF NOT EXISTS reranker_top_n INTEGER NOT NULL DEFAULT 12;
