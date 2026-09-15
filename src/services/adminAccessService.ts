import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db/pool";

export interface KnowledgeBaseRecord {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
  principalCount: number;
}

export interface McpPrincipalRecord {
  id: number;
  name: string;
  principalType: string;
  tokenPreview: string;
  description: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  knowledgeBases: Array<{ id: number; slug: string; name: string }>;
}

export interface AuthenticatedMcpPrincipal {
  id: number;
  name: string;
  isEnabled: boolean;
  knowledgeBaseIds: number[];
}

export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "kb";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function buildTokenPreview(token: string): string {
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

function mapKnowledgeBaseRow(row: {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  document_count: number | string;
  principal_count: number | string;
}): KnowledgeBaseRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    isEnabled: row.is_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    documentCount: Number(row.document_count),
    principalCount: Number(row.principal_count)
  };
}

export async function listKnowledgeBases(): Promise<KnowledgeBaseRecord[]> {
  const result = await pool.query<{
    id: number;
    slug: string;
    name: string;
    description: string | null;
    is_enabled: boolean;
    created_at: string;
    updated_at: string;
    document_count: number | string;
    principal_count: number | string;
  }>(`
    SELECT
      kb.id,
      kb.slug,
      kb.name,
      kb.description,
      kb.is_enabled,
      kb.created_at::text,
      kb.updated_at::text,
      COUNT(DISTINCT d.id) AS document_count,
      COUNT(DISTINCT pkb.principal_id) AS principal_count
    FROM knowledge_bases kb
    LEFT JOIN documents d ON d.knowledge_base_id = kb.id
    LEFT JOIN principal_knowledge_bases pkb ON pkb.knowledge_base_id = kb.id
    GROUP BY kb.id
    ORDER BY kb.name ASC, kb.id ASC
  `);

  return result.rows.map(mapKnowledgeBaseRow);
}

export async function createKnowledgeBase(input: {
  name: string;
  slug?: string;
  description?: string | null;
  isEnabled?: boolean;
}): Promise<KnowledgeBaseRecord> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("knowledge base name is required");
  }

  const slug = normalizeSlug(input.slug?.trim() || name);
  const result = await pool.query<{
    id: number;
    slug: string;
    name: string;
    description: string | null;
    is_enabled: boolean;
    created_at: string;
    updated_at: string;
    document_count: number | string;
    principal_count: number | string;
  }>(
    `
      WITH inserted AS (
        INSERT INTO knowledge_bases (slug, name, description, is_enabled)
        VALUES ($1, $2, $3, $4)
        RETURNING id, slug, name, description, is_enabled, created_at, updated_at
      )
      SELECT inserted.*, 0::bigint AS document_count, 0::bigint AS principal_count
      FROM inserted
    `,
    [slug, name, input.description?.trim() || null, input.isEnabled ?? true]
  );

  return mapKnowledgeBaseRow(result.rows[0]);
}

export async function updateKnowledgeBase(id: number, input: {
  name: string;
  slug?: string;
  description?: string | null;
  isEnabled?: boolean;
}): Promise<KnowledgeBaseRecord | null> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("knowledge base name is required");
  }

  const slug = normalizeSlug(input.slug?.trim() || name);
  const result = await pool.query<{
    id: number;
    slug: string;
    name: string;
    description: string | null;
    is_enabled: boolean;
    created_at: string;
    updated_at: string;
    document_count: number | string;
    principal_count: number | string;
  }>(
    `
      WITH updated AS (
        UPDATE knowledge_bases
        SET slug = $2,
            name = $3,
            description = $4,
            is_enabled = $5,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, slug, name, description, is_enabled, created_at, updated_at
      )
      SELECT updated.*,
             COALESCE((SELECT COUNT(*) FROM documents d WHERE d.knowledge_base_id = updated.id), 0)::bigint AS document_count,
             COALESCE((SELECT COUNT(*) FROM principal_knowledge_bases pkb WHERE pkb.knowledge_base_id = updated.id), 0)::bigint AS principal_count
      FROM updated
    `,
    [id, slug, name, input.description?.trim() || null, input.isEnabled ?? true]
  );

  return result.rows[0] ? mapKnowledgeBaseRow(result.rows[0]) : null;
}

export async function deleteKnowledgeBase(id: number): Promise<boolean> {
  const documentCheck = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM documents WHERE knowledge_base_id = $1",
    [id]
  );
  if (Number(documentCheck.rows[0]?.count ?? 0) > 0) {
    throw new Error("knowledge base still has assigned documents");
  }

  const result = await pool.query("DELETE FROM knowledge_bases WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listMcpPrincipals(): Promise<McpPrincipalRecord[]> {
  const result = await pool.query<{
    id: number;
    name: string;
    principal_type: string;
    token_preview: string;
    description: string | null;
    is_enabled: boolean;
    created_at: string;
    updated_at: string;
    knowledge_bases: Array<{ id: number; slug: string; name: string }> | null;
  }>(`
    SELECT
      p.id,
      p.name,
      p.principal_type,
      p.token_preview,
      p.description,
      p.is_enabled,
      p.created_at::text,
      p.updated_at::text,
      COALESCE(
        json_agg(
          json_build_object('id', kb.id, 'slug', kb.slug, 'name', kb.name)
          ORDER BY kb.name ASC
        ) FILTER (WHERE kb.id IS NOT NULL),
        '[]'::json
      ) AS knowledge_bases
    FROM mcp_principals p
    LEFT JOIN principal_knowledge_bases pkb ON pkb.principal_id = p.id
    LEFT JOIN knowledge_bases kb ON kb.id = pkb.knowledge_base_id
    GROUP BY p.id
    ORDER BY p.name ASC, p.id ASC
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    principalType: row.principal_type,
    tokenPreview: row.token_preview,
    description: row.description,
    isEnabled: row.is_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    knowledgeBases: row.knowledge_bases ?? []
  }));
}

export async function createMcpPrincipal(input: {
  name: string;
  description?: string | null;
  isEnabled?: boolean;
  knowledgeBaseIds?: number[];
}): Promise<{ principal: McpPrincipalRecord; token: string }> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("principal name is required");
  }

  const token = `mcp_${randomBytes(24).toString("hex")}`;
  const tokenHash = hashToken(token);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const insertResult = await client.query<{ id: number }>(
      `
        INSERT INTO mcp_principals (name, token_hash, token_preview, description, is_enabled)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [name, tokenHash, buildTokenPreview(token), input.description?.trim() || null, input.isEnabled ?? true]
    );

    const principalId = insertResult.rows[0].id;
    const knowledgeBaseIds = [...new Set((input.knowledgeBaseIds ?? []).filter((value) => Number.isFinite(value) && value > 0))];
    if (knowledgeBaseIds.length > 0) {
      for (const knowledgeBaseId of knowledgeBaseIds) {
        await client.query(
          `INSERT INTO principal_knowledge_bases (principal_id, knowledge_base_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [principalId, knowledgeBaseId]
        );
      }
    }

    await client.query("COMMIT");
    const principal = (await listMcpPrincipals()).find((entry) => entry.id === principalId);
    if (!principal) {
      throw new Error("created principal could not be loaded");
    }

    return { principal, token };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateMcpPrincipal(id: number, input: {
  name: string;
  description?: string | null;
  isEnabled?: boolean;
  knowledgeBaseIds?: number[];
}): Promise<McpPrincipalRecord | null> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("principal name is required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
        UPDATE mcp_principals
        SET name = $2,
            description = $3,
            is_enabled = $4,
            updated_at = NOW()
        WHERE id = $1
      `,
      [id, name, input.description?.trim() || null, input.isEnabled ?? true]
    );

    if ((result.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("DELETE FROM principal_knowledge_bases WHERE principal_id = $1", [id]);
    const knowledgeBaseIds = [...new Set((input.knowledgeBaseIds ?? []).filter((value) => Number.isFinite(value) && value > 0))];
    for (const knowledgeBaseId of knowledgeBaseIds) {
      await client.query(
        `INSERT INTO principal_knowledge_bases (principal_id, knowledge_base_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, knowledgeBaseId]
      );
    }

    await client.query("COMMIT");
    return (await listMcpPrincipals()).find((entry) => entry.id === id) ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function rotateMcpPrincipalToken(id: number): Promise<{ principal: McpPrincipalRecord; token: string } | null> {
  const token = `mcp_${randomBytes(24).toString("hex")}`;
  const result = await pool.query(
    `
      UPDATE mcp_principals
      SET token_hash = $2,
          token_preview = $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [id, hashToken(token), buildTokenPreview(token)]
  );

  if ((result.rowCount ?? 0) === 0) {
    return null;
  }

  const principal = (await listMcpPrincipals()).find((entry) => entry.id === id);
  if (!principal) {
    throw new Error("updated principal could not be loaded");
  }

  return { principal, token };
}

export async function deleteMcpPrincipal(id: number): Promise<boolean> {
  const result = await pool.query("DELETE FROM mcp_principals WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function hasEnabledMcpPrincipals(): Promise<boolean> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM mcp_principals WHERE is_enabled = TRUE"
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

export async function resolveMcpPrincipalByToken(token: string): Promise<AuthenticatedMcpPrincipal | null> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return null;
  }

  const result = await pool.query<{
    id: number;
    name: string;
    is_enabled: boolean;
    knowledge_base_ids: number[] | null;
  }>(
    `
      SELECT
        p.id,
        p.name,
        p.is_enabled,
        COALESCE(array_agg(pkb.knowledge_base_id ORDER BY pkb.knowledge_base_id) FILTER (WHERE pkb.knowledge_base_id IS NOT NULL), '{}'::bigint[]) AS knowledge_base_ids
      FROM mcp_principals p
      LEFT JOIN principal_knowledge_bases pkb ON pkb.principal_id = p.id
      WHERE p.token_hash = $1
      GROUP BY p.id
      LIMIT 1
    `,
    [hashToken(normalizedToken)]
  );

  const row = result.rows[0];
  if (!row || !row.is_enabled) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    isEnabled: row.is_enabled,
    knowledgeBaseIds: row.knowledge_base_ids ?? []
  };
}
