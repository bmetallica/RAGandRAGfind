-- Schreibrecht je MCP-Zugang. Standard ist aus: bestehende Tokens - Open WebUI
-- und andere Leser - bekommen durch diese Aenderung kein Schreibrecht.
ALTER TABLE mcp_principals
ADD COLUMN IF NOT EXISTS can_write BOOLEAN NOT NULL DEFAULT FALSE;

-- Das Arbeitsmodell von opencode gehoert nicht in den Code: dieselbe
-- Installation soll in einer anderen Landschaft mit einem anderen Modell
-- laufen, ohne dass jemand Konstanten anfasst. Ein Datensatz ohne principal_id
-- traegt die Standardwerte, weitere ueberschreiben sie je Zugang.
CREATE TABLE IF NOT EXISTS opencode_mcp_settings (
  id BIGSERIAL PRIMARY KEY,
  principal_id BIGINT REFERENCES mcp_principals(id) ON DELETE CASCADE,
  model_name TEXT,
  context_window_tokens INTEGER,
  response_budget_chars INTEGER NOT NULL DEFAULT 4000,
  response_hard_cap_chars INTEGER NOT NULL DEFAULT 12000,
  default_top_k INTEGER NOT NULL DEFAULT 6,
  max_top_k INTEGER NOT NULL DEFAULT 20,
  write_knowledge_base_id BIGINT REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Je Zugang hoechstens ein Datensatz, und genau einer fuer die Standardwerte.
-- Ein gewoehnliches UNIQUE wuerde mehrere Zeilen mit leerem principal_id
-- zulassen, weil NULL in Postgres nicht mit sich selbst kollidiert.
CREATE UNIQUE INDEX IF NOT EXISTS opencode_mcp_settings_principal_idx
  ON opencode_mcp_settings (principal_id)
  WHERE principal_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS opencode_mcp_settings_default_idx
  ON opencode_mcp_settings ((TRUE))
  WHERE principal_id IS NULL;

INSERT INTO opencode_mcp_settings (principal_id)
SELECT NULL
WHERE NOT EXISTS (
  SELECT 1 FROM opencode_mcp_settings WHERE principal_id IS NULL
);

-- Von opencode selbst angelegte Dokumente werden ueber den Herkunftstyp
-- gefunden - auch dann, wenn sie in derselben Wissensdatenbank liegen wie der
-- Code. Ohne diesen Index kostet das Auflisten einen vollstaendigen Durchlauf.
CREATE INDEX IF NOT EXISTS idx_documents_source_type_kb
  ON documents (source_type, knowledge_base_id);
