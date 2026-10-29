import { pool } from "../db/pool";

// Das Arbeitsmodell von opencode und die daraus folgenden Budgets stehen in der
// Datenbank, nicht im Code: dieselbe Installation soll in einer anderen
// Landschaft mit einem anderen Modell laufen, ohne dass jemand Konstanten
// anfasst. Ein Datensatz ohne principal_id traegt die Standardwerte, weitere
// ueberschreiben sie je Zugang.
export interface OpencodeMcpSettings {
  principalId: number | null;
  modelName: string | null;
  contextWindowTokens: number | null;
  responseBudgetChars: number;
  responseHardCapChars: number;
  defaultTopK: number;
  maxTopK: number;
  writeKnowledgeBaseId: number | null;
  updatedAt: string | null;
}

export interface OpencodeMcpSettingsInput {
  modelName?: string | null;
  contextWindowTokens?: number | null;
  responseBudgetChars?: number;
  responseHardCapChars?: number;
  defaultTopK?: number;
  maxTopK?: number;
  writeKnowledgeBaseId?: number | null;
}

interface SettingsRow {
  principal_id: string | number | null;
  model_name: string | null;
  context_window_tokens: number | null;
  response_budget_chars: number;
  response_hard_cap_chars: number;
  default_top_k: number;
  max_top_k: number;
  write_knowledge_base_id: string | number | null;
  updated_at: string | null;
}

const SETTINGS_CACHE_TTL_MS = 30_000;

let settingsCache: { value: Map<string, OpencodeMcpSettings>; expiresAt: number } = {
  value: new Map(),
  expiresAt: 0
};

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapRow(row: SettingsRow): OpencodeMcpSettings {
  return {
    principalId: toNumberOrNull(row.principal_id),
    modelName: row.model_name,
    contextWindowTokens: row.context_window_tokens === null ? null : Number(row.context_window_tokens),
    responseBudgetChars: Number(row.response_budget_chars),
    responseHardCapChars: Number(row.response_hard_cap_chars),
    defaultTopK: Number(row.default_top_k),
    maxTopK: Number(row.max_top_k),
    writeKnowledgeBaseId: toNumberOrNull(row.write_knowledge_base_id),
    updatedAt: row.updated_at
  };
}

export function defaultOpencodeMcpSettings(): OpencodeMcpSettings {
  return {
    principalId: null,
    modelName: null,
    contextWindowTokens: null,
    responseBudgetChars: 4000,
    responseHardCapChars: 12000,
    defaultTopK: 6,
    maxTopK: 20,
    writeKnowledgeBaseId: null,
    updatedAt: null
  };
}

async function loadAllSettings(): Promise<Map<string, OpencodeMcpSettings>> {
  const now = Date.now();
  if (settingsCache.expiresAt > now) {
    return settingsCache.value;
  }

  const result = await pool.query<SettingsRow>(
    `
      SELECT
        principal_id,
        model_name,
        context_window_tokens,
        response_budget_chars,
        response_hard_cap_chars,
        default_top_k,
        max_top_k,
        write_knowledge_base_id,
        updated_at::text
      FROM opencode_mcp_settings
    `
  );

  const map = new Map<string, OpencodeMcpSettings>();
  for (const row of result.rows) {
    const settings = mapRow(row);
    map.set(settings.principalId === null ? "default" : String(settings.principalId), settings);
  }

  settingsCache = { value: map, expiresAt: now + SETTINGS_CACHE_TTL_MS };
  return map;
}

// Die Einstellungen eines Zugangs, sonst die Standardwerte. Ein eigener
// Datensatz ersetzt die Standardwerte vollstaendig - teilweises Erben waere
// schwerer nachzuvollziehen als ein Formular, das beim Anlegen vorbelegt wird.
export async function getOpencodeMcpSettings(principalId?: number | null): Promise<OpencodeMcpSettings> {
  const all = await loadAllSettings();
  if (principalId !== null && principalId !== undefined) {
    const perPrincipal = all.get(String(principalId));
    if (perPrincipal) {
      return perPrincipal;
    }
  }

  return all.get("default") ?? defaultOpencodeMcpSettings();
}

export async function listOpencodeMcpSettings(): Promise<OpencodeMcpSettings[]> {
  const all = await loadAllSettings();
  return [...all.values()].sort((left, right) => (left.principalId ?? 0) - (right.principalId ?? 0));
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(parsed), minimum), maximum);
}

export async function saveOpencodeMcpSettings(
  principalId: number | null,
  input: OpencodeMcpSettingsInput
): Promise<OpencodeMcpSettings> {
  const current = await getOpencodeMcpSettings(principalId);
  const responseBudgetChars = clampInteger(input.responseBudgetChars, 500, 200_000, current.responseBudgetChars);
  // Der harte Deckel darf nie unter dem Budget liegen, sonst waere die
  // Obergrenze enger als der Regelfall.
  const responseHardCapChars = clampInteger(
    input.responseHardCapChars,
    responseBudgetChars,
    500_000,
    Math.max(current.responseHardCapChars, responseBudgetChars)
  );
  const defaultTopK = clampInteger(input.defaultTopK, 1, 50, current.defaultTopK);
  const maxTopK = clampInteger(input.maxTopK, defaultTopK, 50, Math.max(current.maxTopK, defaultTopK));
  const contextWindowTokens = input.contextWindowTokens === null || input.contextWindowTokens === undefined
    ? null
    : clampInteger(input.contextWindowTokens, 1000, 10_000_000, current.contextWindowTokens ?? 32_000);
  const modelName = typeof input.modelName === "string"
    ? input.modelName.trim() || null
    : input.modelName ?? null;
  const writeKnowledgeBaseId = input.writeKnowledgeBaseId === null || input.writeKnowledgeBaseId === undefined
    ? null
    : Number(input.writeKnowledgeBaseId) || null;

  const values = [
    principalId,
    modelName,
    contextWindowTokens,
    responseBudgetChars,
    responseHardCapChars,
    defaultTopK,
    maxTopK,
    writeKnowledgeBaseId
  ];

  const columns = `
        model_name = EXCLUDED.model_name,
        context_window_tokens = EXCLUDED.context_window_tokens,
        response_budget_chars = EXCLUDED.response_budget_chars,
        response_hard_cap_chars = EXCLUDED.response_hard_cap_chars,
        default_top_k = EXCLUDED.default_top_k,
        max_top_k = EXCLUDED.max_top_k,
        write_knowledge_base_id = EXCLUDED.write_knowledge_base_id,
        updated_at = NOW()`;

  // Zwei Konflikt-Ziele, weil die Eindeutigkeit ueber zwei Teilindexe laeuft:
  // einer fuer die Standardwerte, einer je Zugang.
  const conflictTarget = principalId === null
    ? "((TRUE)) WHERE principal_id IS NULL"
    : "(principal_id) WHERE principal_id IS NOT NULL";

  const result = await pool.query<SettingsRow>(
    `
      INSERT INTO opencode_mcp_settings (
        principal_id,
        model_name,
        context_window_tokens,
        response_budget_chars,
        response_hard_cap_chars,
        default_top_k,
        max_top_k,
        write_knowledge_base_id,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT ${conflictTarget}
      DO UPDATE SET ${columns}
      RETURNING
        principal_id,
        model_name,
        context_window_tokens,
        response_budget_chars,
        response_hard_cap_chars,
        default_top_k,
        max_top_k,
        write_knowledge_base_id,
        updated_at::text
    `,
    values
  );

  invalidateOpencodeMcpSettingsCache();
  return mapRow(result.rows[0]);
}

export async function deleteOpencodeMcpSettings(principalId: number): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM opencode_mcp_settings WHERE principal_id = $1",
    [principalId]
  );
  invalidateOpencodeMcpSettingsCache();
  return (result.rowCount ?? 0) > 0;
}

export function invalidateOpencodeMcpSettingsCache(): void {
  settingsCache = { value: new Map(), expiresAt: 0 };
}
