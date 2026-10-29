import express from "express";
import { z } from "zod/v4";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { logger } from "../utils/logger";
import type { AuthenticatedMcpPrincipal } from "../services/adminAccessService";
import { resolveMcpPrincipalByToken } from "../services/adminAccessService";
import { executeDocumentFulltextQuery, executeSmartSearchQuery } from "../routes/api";
import {
  AGENT_FILE_SOURCE_TYPE,
  AGENT_NOTE_SOURCE_TYPE,
  AgentKnowledgeService,
  buildFileSourceRef,
  buildNoteSourceRef,
  normalizeKey
} from "../services/agentKnowledgeService";
import {
  getOpencodeMcpSettings,
  type OpencodeMcpSettings
} from "../services/opencodeMcpSettingsService";

// Warum ein zweiter MCP-Server
//
// Der bestehende Server unter /mcp bietet 25 Werkzeuge an - Fristen,
// Meeting-Aufgaben, Dokumentvergleich, Versionsvergleich. Fuer einen
// Coding-Agenten sind davon hoechstens fuenf brauchbar, der Rest belegt
// Kontext und verschlechtert die Auswahl. Dieser Server bietet sieben scharf
// umrissene Werkzeuge an und teilt sich mit dem ersten alles darunter:
// Authentifizierung, Scope, Retrieval-Pipeline, Ingestion.

const AGENT_SOURCE_TYPES = [AGENT_NOTE_SOURCE_TYPE, AGENT_FILE_SOURCE_TYPE];

interface McpModules {
  McpServer: any;
  NodeStreamableHTTPServerTransport: any;
}

let mcpModulesPromise: Promise<McpModules> | null = null;

async function loadMcpModules(): Promise<McpModules> {
  if (!mcpModulesPromise) {
    mcpModulesPromise = (async () => {
      const serverModule: any = await import("@modelcontextprotocol/server");
      const nodeModule: any = await import("@modelcontextprotocol/node");
      return {
        McpServer: serverModule.McpServer,
        NodeStreamableHTTPServerTransport: nodeModule.NodeStreamableHTTPServerTransport
      };
    })();
  }

  return mcpModulesPromise;
}

function extractMcpToken(request: express.Request): string | null {
  const header = request.header("authorization") ?? request.header("Authorization");
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1].trim();
    }
  }

  const direct = request.header("x-mcp-token") ?? request.header("X-MCP-Token");
  return direct ? direct.trim() : null;
}

// Jede Antwort wird auf das eingestellte Budget gekuerzt und die Kuerzung
// sichtbar gemacht. Ein Agent, der nicht sieht, dass etwas fehlt, zieht aus
// einer halben Datei falsche Schluesse.
function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n\n[gekuerzt: ${text.length - limit} weitere Zeichen. Bereich ueber startLine/endLine anfordern.]`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function describeKind(sourceType: string): "note" | "file" | "code" | "doc" {
  if (sourceType === AGENT_NOTE_SOURCE_TYPE) {
    return "note";
  }
  if (sourceType === AGENT_FILE_SOURCE_TYPE) {
    return "file";
  }
  return sourceType === "git" ? "code" : "doc";
}

function sourceTypesForKind(kind?: string): string[] | undefined {
  if (kind === "note") {
    return [AGENT_NOTE_SOURCE_TYPE];
  }
  if (kind === "file") {
    return [AGENT_FILE_SOURCE_TYPE];
  }
  if (kind === "code") {
    return ["git", AGENT_FILE_SOURCE_TYPE];
  }
  if (kind === "doc") {
    return ["directory", "upload", "crawl", "crawl-file"];
  }
  return undefined;
}

async function resolveWriteKnowledgeBaseId(
  principal: AuthenticatedMcpPrincipal | null,
  settings: OpencodeMcpSettings
): Promise<number> {
  const allowed = principal?.knowledgeBaseIds ?? [];

  if (settings.writeKnowledgeBaseId) {
    if (allowed.length > 0 && !allowed.includes(settings.writeKnowledgeBaseId)) {
      throw new Error(
        "the configured write knowledge base is not assigned to this access token; fix it in the admin UI"
      );
    }
    return settings.writeKnowledgeBaseId;
  }

  // Bei genau einer zugeordneten Wissensdatenbank gibt es nichts zu raten.
  if (allowed.length === 1) {
    return allowed[0];
  }

  throw new Error(
    allowed.length === 0
      ? "no knowledge base is assigned to this access token"
      : "several knowledge bases are assigned; pick the write target in the admin UI (opencode MCP settings)"
  );
}

export async function createOpencodeMcpServer(principal: AuthenticatedMcpPrincipal | null) {
  const { McpServer } = await loadMcpModules();
  const settings = await getOpencodeMcpSettings(principal?.id ?? null);
  const allowedKnowledgeBaseIds = principal?.knowledgeBaseIds;
  const agentKnowledge = new AgentKnowledgeService();
  const budget = settings.responseBudgetChars;
  const hardCap = settings.responseHardCapChars;

  const server = new McpServer(
    { name: "rag-opencode-mcp", version: "0.1.0" },
    { capabilities: { logging: {} } }
  );

  const requireWrite = () => {
    if (!principal) {
      throw new Error("writing requires an MCP access token");
    }
    if (!principal.canWrite) {
      throw new Error(`access token "${principal.name}" has no write permission; enable it in the admin UI`);
    }
  };

  /* Lesen ---------------------------------------------------------------- */

  server.registerTool(
    "search_knowledge",
    {
      title: "Search knowledge",
      description:
        "Search the knowledge base for code, documentation and own notes. Returns short excerpts with their source path.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What to look for."),
        topK: z.number().int().min(1).max(settings.maxTopK).optional().describe("How many hits to return."),
        kind: z.enum(["code", "doc", "note", "file"]).optional().describe("Restrict to a kind of source."),
        pathPrefix: z.string().optional().describe("Only hits whose source path starts with this.")
      })
    },
    async (args: { query: string; topK?: number; kind?: string; pathPrefix?: string }) => {
      const payload = await executeSmartSearchQuery({
        query: args.query,
        topK: Math.min(args.topK ?? settings.defaultTopK, settings.maxTopK),
        model: env.EMBEDDING_MODEL,
        sourceTypes: sourceTypesForKind(args.kind),
        allowedKnowledgeBaseIds
      });

      const prefix = args.pathPrefix?.trim().toLowerCase();
      const items = prefix
        ? payload.items.filter((item) => item.sourceRef.toLowerCase().includes(prefix))
        : payload.items;

      if (items.length === 0) {
        return textResult("No matches.");
      }

      // Das Budget teilt sich auf die Treffer auf: lieber mehrere kurze
      // Auszuege als ein langer, der die anderen verdraengt.
      const perItem = Math.max(Math.floor(budget / Math.max(items.length, 1)), 200);
      const lines = items.map((item, index) => [
        `${index + 1}. ${item.title ?? item.sourceRef}`,
        `   kind: ${describeKind(item.sourceType)}  score: ${item.score.toFixed(3)}`,
        `   ref: ${item.sourceRef}`,
        `   ${item.content.replace(/\s+/g, " ").slice(0, perItem)}`
      ].join("\n"));

      return textResult(clip(lines.join("\n\n"), hardCap));
    }
  );

  server.registerTool(
    "get_file",
    {
      title: "Get file or document",
      description: "Return the content of one file or document by its ref or path. Use startLine/endLine for long files.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Source ref or path as returned by search_knowledge."),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional()
      })
    },
    async (args: { ref: string; startLine?: number; endLine?: number }) => {
      const payload = await executeDocumentFulltextQuery({
        sourceRef: args.ref,
        maxChars: hardCap,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        return textResult(`Nothing found for "${args.ref}".`);
      }

      const allLines = payload.fulltext.split("\n");
      const start = args.startLine ? Math.max(args.startLine, 1) : 1;
      const end = args.endLine ? Math.min(args.endLine, allLines.length) : allLines.length;
      const selected = allLines.slice(start - 1, end);
      const numbered = selected.map((line, index) => `${start + index}: ${line}`).join("\n");
      const header = [
        `ref: ${payload.document.sourceRef}`,
        `lines: ${start}-${Math.min(end, allLines.length)} of ${allLines.length}`,
        ""
      ].join("\n");

      return textResult(header + clip(numbered, args.startLine || args.endLine ? hardCap : budget));
    }
  );

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description: "List available files, documents and notes to navigate the knowledge base.",
      inputSchema: z.object({
        pathPrefix: z.string().optional(),
        kind: z.enum(["code", "doc", "note", "file"]).optional(),
        limit: z.number().int().min(1).max(200).optional()
      })
    },
    async (args: { pathPrefix?: string; kind?: string; limit?: number }) => {
      const sourceTypes = sourceTypesForKind(args.kind);
      const result = await pool.query<{ source_ref: string; title: string | null; source_type: string; updated_at: string }>(
        `
          SELECT source_ref, title, source_type, updated_at::text
          FROM documents
          WHERE ($1::bigint[] IS NULL OR (cardinality($1::bigint[]) > 0 AND knowledge_base_id = ANY($1::bigint[])))
            AND ($2::text[] IS NULL OR source_type = ANY($2::text[]))
            AND ($3::text IS NULL OR source_ref ILIKE '%' || $3::text || '%')
          ORDER BY source_ref ASC
          LIMIT $4::integer
        `,
        [
          allowedKnowledgeBaseIds ?? null,
          sourceTypes ?? null,
          args.pathPrefix?.trim() || null,
          Math.min(args.limit ?? 50, 200)
        ]
      );

      if (result.rows.length === 0) {
        return textResult("No sources match.");
      }

      const lines = result.rows.map((row) => `${describeKind(row.source_type).padEnd(4)}  ${row.source_ref}`);
      return textResult(clip(lines.join("\n"), hardCap));
    }
  );

  server.registerTool(
    "get_note",
    {
      title: "Get note",
      description: "Read one of your own notes in full, so you can extend it instead of writing a second one.",
      inputSchema: z.object({
        noteKey: z.string().min(1)
      })
    },
    async (args: { noteKey: string }) => {
      const payload = await executeDocumentFulltextQuery({
        sourceRef: buildNoteSourceRef(args.noteKey),
        maxChars: hardCap,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        return textResult(`No note stored under "${normalizeKey(args.noteKey)}".`);
      }

      return textResult(clip(payload.fulltext, hardCap));
    }
  );

  /* Schreiben ------------------------------------------------------------ */

  server.registerTool(
    "save_note",
    {
      title: "Save note",
      description:
        "Store knowledge under a stable key. Writing the same key again replaces the previous note - read it with get_note first and extend it.",
      inputSchema: z.object({
        noteKey: z.string().min(1).describe("Stable identifier, e.g. 'deploy/staging-rollout'."),
        title: z.string().min(1),
        text: z.string().min(1),
        tags: z.array(z.string()).optional()
      })
    },
    async (args: { noteKey: string; title: string; text: string; tags?: string[] }) => {
      requireWrite();
      const knowledgeBaseId = await resolveWriteKnowledgeBaseId(principal, settings);
      const result = await agentKnowledge.saveNote({
        noteKey: args.noteKey,
        title: args.title,
        text: args.text,
        tags: args.tags,
        knowledgeBaseId,
        principalName: principal?.name ?? null
      });

      const lines = [
        result.replacedDocumentId !== null
          ? `Replaced the previous note (document ${result.replacedDocumentId}).`
          : "Stored as a new note.",
        `ref: ${result.sourceRef}`,
        `chunks: ${result.chunkCount} (embedding runs in the background, full-text search works immediately)`
      ];

      if (result.containsSecrets) {
        lines.push(
          `WARNING: this text looks like it contains credentials (${result.secretKinds.join(", ")}). It was stored and flagged - remove it if that was unintended.`
        );
      }

      return textResult(lines.join("\n"));
    }
  );

  server.registerTool(
    "save_file",
    {
      title: "Save file",
      description: "Store a source file under its path. Writing the same path again replaces the previous content.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string().min(1),
        language: z.string().optional()
      })
    },
    async (args: { path: string; content: string; language?: string }) => {
      requireWrite();
      const knowledgeBaseId = await resolveWriteKnowledgeBaseId(principal, settings);
      const result = await agentKnowledge.saveFile({
        path: args.path,
        content: args.content,
        language: args.language,
        knowledgeBaseId,
        principalName: principal?.name ?? null
      });

      const lines = [
        result.replacedDocumentId !== null
          ? `Replaced the previous version (document ${result.replacedDocumentId}).`
          : "Stored as a new file.",
        `ref: ${result.sourceRef}`,
        `chunks: ${result.chunkCount}`
      ];

      if (result.containsSecrets) {
        lines.push(
          `WARNING: this file looks like it contains credentials (${result.secretKinds.join(", ")}). It was stored and flagged.`
        );
      }

      return textResult(lines.join("\n"));
    }
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description: "Delete one of your own notes or stored files. Cannot touch crawled, uploaded or git-synced documents.",
      inputSchema: z.object({
        noteKey: z.string().optional().describe("Key of the note to delete."),
        path: z.string().optional().describe("Path of the stored file to delete.")
      })
    },
    async (args: { noteKey?: string; path?: string }) => {
      requireWrite();
      if (!args.noteKey && !args.path) {
        return textResult("Pass either noteKey or path.");
      }

      const knowledgeBaseId = await resolveWriteKnowledgeBaseId(principal, settings);
      const sourceRef = args.noteKey ? buildNoteSourceRef(args.noteKey) : buildFileSourceRef(args.path!);
      const deleted = await agentKnowledge.forget({ sourceRef, knowledgeBaseId });

      return textResult(deleted ? `Deleted ${sourceRef}.` : `Nothing stored under ${sourceRef}.`);
    }
  );

  return server;
}

export function createOpencodeMcpRouter(): express.Router {
  const router = express.Router();

  // Anders als beim bestehenden Server ist ein Token hier immer noetig. Der
  // alte laesst ohne angelegte Principals jeden durch - fuer einen Endpunkt,
  // der auch schreibt, waere das falsch.
  router.use(async (request, response, next) => {
    try {
      const token = extractMcpToken(request);
      if (!token) {
        response.status(401).json({ error: "missing MCP access token" });
        return;
      }

      const principal = await resolveMcpPrincipalByToken(token);
      if (!principal) {
        response.status(401).json({ error: "invalid MCP access token" });
        return;
      }

      response.locals.mcpPrincipal = principal;
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (_request, response) => {
    response.json({
      name: "rag-opencode-mcp",
      transport: "streamable-http",
      endpoint: "/mcp/opencode",
      tools: [
        "search_knowledge",
        "get_file",
        "list_sources",
        "get_note",
        "save_note",
        "save_file",
        "forget"
      ]
    });
  });

  router.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  router.delete("/", (_request, response) => {
    response.status(204).end();
  });

  router.post("/", async (request, response, next) => {
    try {
      const { NodeStreamableHTTPServerTransport } = await loadMcpModules();
      const principal: AuthenticatedMcpPrincipal | null = response.locals.mcpPrincipal ?? null;
      const server = await createOpencodeMcpServer(principal);
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

      await server.connect(transport);
      try {
        await transport.handleRequest(request, response, request.body);
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    } catch (error) {
      logger.error({ err: error }, "opencode mcp request failed");
      next(error);
    }
  });

  return router;
}

export { AGENT_SOURCE_TYPES };
