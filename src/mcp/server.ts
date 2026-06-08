import express from "express";
import { z } from "zod/v4";
import { env } from "../config/env";
import type { AuthenticatedMcpPrincipal } from "../services/adminAccessService";
import { hasEnabledMcpPrincipals, resolveMcpPrincipalByToken } from "../services/adminAccessService";
import type { AnalysisResponse } from "../services/analysisService";
import {
  executeApiSurfaceQuery,
  executeConfigKeysQuery,
  executeCompareDocumentsQuery,
  executeCompareDocumentVersionsQuery,
  executeCrossReferenceQuery,
  executeDeadlinesQuery,
  executeDecisionsQuery,
  executeEntitiesQuery,
  executeDocumentContextQuery,
  executeDocumentFulltextQuery,
  executeDocumentOriginalQuery,
  executeRequirementsQuery,
  executeRisksQuery,
  executeOperationalNotesQuery,
  executeDocumentSummaryQuery,
  executeDocumentSectionsQuery,
  executeDocumentStructureQuery,
  executeMeetingActionsQuery,
  executeSectionSummaryQuery,
  executeSingleDocumentSectionQuery,
  executeDocumentInventoryQuery,
  executeQuery,
  executeSetupStepsQuery,
  executeSmartSearchQuery,
  type DocumentOriginalResponse,
  type DocumentStructureResponse,
  type DocumentFulltextResponse,
  type DocumentComparisonResponse,
  type DocumentSectionResponse,
  type DocumentSectionsResponse,
  type QueryResponse,
  type TopicCrossReferenceResponse
} from "../routes/api";

function formatQueryResponse(payload: QueryResponse): string {
  const excerptLimit = 2400;
  const combinedContextLimit = 16000;
  const lines: string[] = [
    `Mode: ${payload.mode}`,
    `Answer guidance: ${payload.answerGuidance}`,
    ""
  ];

  if (payload.items.length === 0) {
    lines.push("No matching documents found.");
    return lines.join("\n");
  }

  lines.push("Top matches:");

  for (const [index, item] of payload.items.entries()) {
    lines.push(
      `${index + 1}. ${item.title ?? item.sourceRef}`,
      `   source_ref: ${item.sourceRef}`,
      `   source_type: ${item.sourceType}`,
      `   score: ${item.score.toFixed(4)}`,
      `   excerpt: ${item.content.slice(0, excerptLimit)}`,
      ""
    );
  }

  lines.push("Combined context:", payload.context.slice(0, combinedContextLimit));
  return lines.join("\n").trim();
}

function formatInventoryResponse(payload: QueryResponse): string {
  const lines = [
    "Available documents:",
    ...payload.items.map(
      (item: QueryResponse["items"][number], index: number) =>
        `${index + 1}. ${item.title ?? item.sourceRef} | ${item.sourceType} | ${item.sourceRef}`
    )
  ];

  return lines.join("\n");
}

function formatDocumentLocator(documentId?: number, sourceRef?: string): string {
  if (documentId) {
    return `document_id=${documentId}`;
  }

  return `source_ref=${sourceRef ?? "unknown"}`;
}

function formatFulltextResponse(payload: DocumentFulltextResponse): string {
  const title = payload.document.title ?? payload.document.sourceRef;
  const lines = [
    `Document: ${title}`,
    `Locator: ${formatDocumentLocator(payload.document.id, payload.document.sourceRef)}`,
    `Source type: ${payload.document.sourceType}`,
    `Truncated: ${payload.truncated ? "yes" : "no"}`,
    `Total length: ${payload.totalLength}`,
  ];

  if (payload.originalFile?.downloadUrl) {
    lines.push(`Original download URL: ${payload.originalFile.downloadUrl}`);
    lines.push(`Original file name: ${payload.originalFile.originalName ?? "-"}`);
    lines.push("If the user asks for the complete/original document, provide the Original download URL instead of only quoting the extracted text.");
  }

  lines.push("", payload.fulltext);
  return lines.join("\n");
}

function formatSectionsResponse(payload: DocumentSectionsResponse): string {
  const title = payload.document.title ?? payload.document.sourceRef;
  const lines = [`Document: ${title}`, "Sections:", ""];

  for (const section of payload.sections) {
    lines.push(
      `[${section.index}] ${section.title}`,
      `   type: ${section.sectionType}`,
      `   match_score: ${section.matchScore}`,
      `   offsets: ${section.startOffset}-${section.endOffset}`,
      `   pages: ${section.pageStart ?? "-"}-${section.pageEnd ?? "-"}`,
      `   preview: ${section.preview}`,
      ""
    );
  }

  return lines.join("\n").trim();
}

function formatSectionResponse(payload: DocumentSectionResponse): string {
  const title = payload.document.title ?? payload.document.sourceRef;
  const section = payload.section;

  return [
    `Document: ${title}`,
    `Section: [${section.index}] ${section.title}`,
    `Section type: ${section.sectionType}`,
    `Match score: ${section.matchScore}`,
    `Offsets: ${section.startOffset}-${section.endOffset}`,
    `Pages: ${section.pageStart ?? "-"}-${section.pageEnd ?? "-"}`,
    "",
    section.content
  ].join("\n");
}

function formatStructureResponse(payload: DocumentStructureResponse): string {
  const title = payload.document.title ?? payload.document.sourceRef;
  const lines = [`Document: ${title}`, `Document type: ${payload.documentType}`, "Structure:", ""];

  for (const node of payload.nodes) {
    lines.push(
      `${"  ".repeat(Math.max(0, node.level - 1))}- [${node.index}] ${node.title}`,
      `  type: ${node.sectionType} | pages: ${node.pageStart ?? "-"}-${node.pageEnd ?? "-"}`,
      `  preview: ${node.preview}`,
      ""
    );
  }

  return lines.join("\n").trim();
}

function formatOriginalResponse(payload: DocumentOriginalResponse): string {
  const title = payload.document.title ?? payload.document.sourceRef;
  if (!payload.originalFile) {
    return [`Document: ${title}`, "No original file reference available."].join("\n");
  }

  return [
    `Document: ${title}`,
    `Original name: ${payload.originalFile.originalName ?? "-"}`,
    `Storage kind: ${payload.originalFile.storageKind}`,
    `Local available: ${payload.originalFile.localAvailable ? "yes" : "no"}`,
    `Download URL: ${payload.originalFile.downloadUrl}`,
    `External URL: ${payload.originalFile.externalUrl ?? "-"}`,
    `MIME type: ${payload.originalFile.mimeType ?? "-"}`,
    `Size: ${payload.originalFile.fileSizeBytes ?? "-"}`,
    "Use this Download URL when the user asks for the complete document, the original PDF/file, or a downloadable source copy."
  ].join("\n");
}

function formatAnalysisResponse(label: string, payload: AnalysisResponse): string {
  const title = payload.document.title ?? payload.document.sourceRef;
  const lines = [`Document: ${title}`, `${label}:`, ""];

  if (payload.items.length === 0) {
    lines.push("No matching items found.");
    return lines.join("\n");
  }

  for (const [index, item] of payload.items.entries()) {
    lines.push(
      `${index + 1}. ${item.text}`,
      `   section: ${item.sectionTitle ?? "-"} [${item.sectionIndex ?? "-"}]`,
      `   confidence: ${item.confidence}`,
      `   assignee: ${item.assignee ?? "-"}`,
      `   due_date: ${item.dueDate ?? "-"}`,
      `   status: ${item.status ?? "-"}`,
      `   entity_type: ${item.entityType ?? "-"}`,
      `   normalized_value: ${item.normalizedValue ?? "-"}`,
      ""
    );
  }

  return lines.join("\n").trim();
}

function formatSummaryResponse(payload: { summary: string; method: string; excerptCount: number; document: { title: string | null; sourceRef: string }; scope: { type: string; sectionTitle?: string; sectionIndex?: number } }): string {
  const title = payload.document.title ?? payload.document.sourceRef;
  return [
    `Document: ${title}`,
    `Scope: ${payload.scope.type}${payload.scope.sectionTitle ? ` (${payload.scope.sectionTitle} [${payload.scope.sectionIndex ?? "-"}])` : ""}`,
    `Method: ${payload.method}`,
    `Excerpt count: ${payload.excerptCount}`,
    "",
    payload.summary
  ].join("\n");
}

function formatComparisonResponse(payload: DocumentComparisonResponse): string {
  const lines = [
    `Mode: ${payload.mode}`,
    `Left document: ${payload.leftDocument.title ?? payload.leftDocument.sourceRef}`,
    `Right document: ${payload.rightDocument.title ?? payload.rightDocument.sourceRef}`,
    "",
    payload.summary,
    "",
    `Common themes: ${payload.commonThemes.join(", ") || "-"}`,
    `Left only themes: ${payload.leftOnlyThemes.join(", ") || "-"}`,
    `Right only themes: ${payload.rightOnlyThemes.join(", ") || "-"}`,
    "",
    `Shared actions: ${payload.sharedActions.length}`,
    `Left only actions: ${payload.leftOnlyActions.length}`,
    `Right only actions: ${payload.rightOnlyActions.length}`
  ];

  return lines.join("\n");
}

function formatCrossReferenceResponse(payload: TopicCrossReferenceResponse): string {
  const lines = [`Topic: ${payload.topic}`, "Cross references:", ""];
  if (payload.items.length === 0) {
    lines.push("No cross references found.");
    return lines.join("\n");
  }

  for (const [index, item] of payload.items.entries()) {
    lines.push(
      `${index + 1}. ${item.document.title ?? item.document.sourceRef}`,
      `   section: ${item.sectionTitle ?? "-"} [${item.sectionIndex ?? "-"}]`,
      `   relation: ${item.relation}`,
      `   score: ${item.score}`,
      `   excerpt: ${item.excerpt}`,
      ""
    );
  }

  return lines.join("\n").trim();
}

async function loadMcpModules() {
  const [{ McpServer }, { NodeStreamableHTTPServerTransport }] = await Promise.all([
    import("@modelcontextprotocol/server"),
    import("@modelcontextprotocol/node")
  ]);

  return {
    McpServer,
    NodeStreamableHTTPServerTransport
  };
}

async function createRagMcpServer(principal?: AuthenticatedMcpPrincipal | null) {
  const { McpServer } = await loadMcpModules();
  const allowedKnowledgeBaseIds = principal?.knowledgeBaseIds;
  const withScope = <T extends Record<string, unknown>>(args: T): T & { allowedKnowledgeBaseIds?: number[] } =>
    allowedKnowledgeBaseIds !== undefined
      ? { ...args, allowedKnowledgeBaseIds }
      : args;
  const server = new McpServer(
    {
      name: "rag-ingestor-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  server.registerTool(
    "search_rag_context",
    {
      title: "Search RAG Context",
      description: "Search the ingested RAG corpus and return the most relevant document excerpts.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Natural-language search query."),
        topK: z.number().int().min(1).max(20).default(env.QUERY_TOP_K).describe("Maximum number of matching chunks to return."),
        model: z.string().optional().describe("Embedding model override for the retrieval query.")
      })
    },
    async (args: { query: string; topK: number; model?: string }) => {
      const { query, topK, model } = args;
      const payload = await executeQuery(query, topK, model ?? env.EMBEDDING_MODEL, undefined, undefined, allowedKnowledgeBaseIds);

      return {
        content: [
          {
            type: "text",
            text: formatQueryResponse(payload)
          }
        ]
      };
    }
  );

  server.registerTool(
    "smart_search",
    {
      title: "Smart Search",
      description: "Search with document-type and category filters plus reranking and expanded context.",
      inputSchema: z.object({
        query: z.string().min(1),
        topK: z.number().int().min(1).max(20).default(env.QUERY_TOP_K),
        model: z.string().optional(),
        category: z.string().optional().describe("Optional category such as local, web, protocol, book, paper, or policy."),
        documentType: z.string().optional().describe("Optional inferred document type such as protocol, documentation, book, paper, or policy."),
        sourceTypes: z.array(z.string()).optional(),
        fileTypes: z.array(z.string()).optional()
      })
    },
    async (args: { query: string; topK: number; model?: string; category?: string; documentType?: string; sourceTypes?: string[]; fileTypes?: string[] }) => {
      const payload = await executeSmartSearchQuery(withScope({
        query: args.query,
        topK: args.topK,
        model: args.model ?? env.EMBEDDING_MODEL,
        category: args.category,
        documentType: args.documentType,
        sourceTypes: args.sourceTypes,
        fileTypes: args.fileTypes,
        enableSmallToBig: false,
        preferDocumentFocus: false,
        preferAdjacentSections: false,
        requireFocusTerms: false
      }));

      return {
        content: [
          {
            type: "text",
            text: formatQueryResponse(payload)
          }
        ]
      };
    }
  );

  server.registerTool(
    "list_documents",
    {
      title: "List Indexed Documents",
      description: "List documents currently available in the RAG database, prioritizing local uploads and synced files.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(12).describe("Maximum number of documents to return.")
      })
    },
    async (args: { limit: number }) => {
      const { limit } = args;
      const payload = await executeDocumentInventoryQuery("welche dokumente gibt es", limit, env.EMBEDDING_MODEL, allowedKnowledgeBaseIds);

      return {
        content: [
          {
            type: "text",
            text: formatInventoryResponse(payload)
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_document_context",
    {
      title: "Get Document Context",
      description: "Fetch chunks from a specific document by source reference or document id for targeted follow-up questions.",
      inputSchema: z.object({
        sourceRef: z.string().optional().describe("Exact or partial source_ref/title of the target document."),
        documentId: z.number().int().positive().optional().describe("Numeric document id when already known."),
        query: z.string().optional().describe("Optional question used to rank chunks inside the selected document."),
        maxChunks: z.number().int().min(1).max(12).default(5).describe("Maximum number of excerpts to return from the document.")
      })
    },
    async (args: { sourceRef?: string; documentId?: number; query?: string; maxChunks: number }) => {
      const { sourceRef, documentId, query, maxChunks } = args;
      const payload = await executeDocumentContextQuery(withScope({ sourceRef, documentId, query, maxChunks }));

      if (!payload) {
        return {
          content: [
            {
              type: "text",
              text: "No matching document was found for the provided sourceRef or documentId."
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text",
            text: formatQueryResponse(payload)
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_document_fulltext",
    {
      title: "Get Document Fulltext",
      description: "Return extracted text for a single document. Use this for reading/searching content, not as the primary tool for delivering the original PDF/file to the user.",
      inputSchema: z.object({
        sourceRef: z.string().optional().describe("Exact or partial source_ref/title of the target document."),
        documentId: z.number().int().positive().optional().describe("Numeric document id when already known."),
        maxChars: z.number().int().min(1000).max(200000).default(40000).describe("Maximum number of characters to return.")
      })
    },
    async (args: { sourceRef?: string; documentId?: number; maxChars: number }) => {
      const payload = await executeDocumentFulltextQuery(withScope(args));

      return {
        content: [
          {
            type: "text",
            text: payload
              ? formatFulltextResponse(payload)
              : "No matching document was found for the provided sourceRef or documentId."
          }
        ]
      };
    }
  );

  server.registerTool(
    "list_document_sections",
    {
      title: "List Document Sections",
      description: "List heuristic sections for a document and optionally rank them for a follow-up query.",
      inputSchema: z.object({
        sourceRef: z.string().optional().describe("Exact or partial source_ref/title of the target document."),
        documentId: z.number().int().positive().optional().describe("Numeric document id when already known."),
        query: z.string().optional().describe("Optional query used to rank likely relevant sections."),
        limit: z.number().int().min(1).max(50).default(12).describe("Maximum number of sections to return.")
      })
    },
    async (args: { sourceRef?: string; documentId?: number; query?: string; limit: number }) => {
      const payload = await executeDocumentSectionsQuery(withScope(args));

      return {
        content: [
          {
            type: "text",
            text: payload
              ? formatSectionsResponse(payload)
              : "No matching document was found for the provided sourceRef or documentId."
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_document_structure",
    {
      title: "Get Document Structure",
      description: "Return a structure-oriented view of a document with section levels and previews.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(200).default(100)
      })
    },
    async (args: { sourceRef?: string; documentId?: number; limit: number }) => {
      const payload = await executeDocumentStructureQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatStructureResponse(payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_document_section",
    {
      title: "Get Document Section",
      description: "Return a single section from a document by section index or by ranking sections against a query.",
      inputSchema: z.object({
        sourceRef: z.string().optional().describe("Exact or partial source_ref/title of the target document."),
        documentId: z.number().int().positive().optional().describe("Numeric document id when already known."),
        sectionIndex: z.number().int().min(0).optional().describe("Exact section index returned by list_document_sections."),
        query: z.string().optional().describe("If no sectionIndex is provided, use this query to choose the best section.")
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeSingleDocumentSectionQuery(withScope(args));

      return {
        content: [
          {
            type: "text",
            text: payload
              ? formatSectionResponse(payload)
              : "No matching document section was found for the provided locator or query."
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_original_document",
    {
      title: "Get Original Document",
      description: "Return metadata and a stable download link for the original source file of a document. Prefer this tool when the user asks for the complete document, original PDF, original file, attachment, or download link.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number }) => {
      const payload = await executeDocumentOriginalQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatOriginalResponse(payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_document_download_link",
    {
      title: "Get Document Download Link",
      description: "Return a stable download link for the original document file. Use this when the user wants the complete/original document instead of extracted text.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number }) => {
      const payload = await executeDocumentOriginalQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatOriginalResponse(payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_meeting_actions",
    {
      title: "Extract Meeting Actions",
      description: "Extract open tasks, responsibilities, and action items from a meeting protocol or similar document.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeMeetingActionsQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("Meeting actions", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_decisions",
    {
      title: "Extract Decisions",
      description: "Extract explicit decisions, approvals, and resolutions from a document or section.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeDecisionsQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("Decisions", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_deadlines",
    {
      title: "Extract Deadlines",
      description: "Extract deadlines, due dates, and time-bound commitments from a document or section.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeDeadlinesQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("Deadlines", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_requirements",
    {
      title: "Extract Requirements",
      description: "Extract requirements, prerequisites, dependencies, and setup conditions from a document or section.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeRequirementsQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("Requirements", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_config_keys",
    {
      title: "Extract Config Keys",
      description: "Extract config keys, environment variables, and CLI flags from a document or section.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeConfigKeysQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("Config keys", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_setup_steps",
    {
      title: "Extract Setup Steps",
      description: "Extract installation, setup, configuration, and run steps from a document or section.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeSetupStepsQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("Setup steps", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_api_surface",
    {
      title: "Extract API Surface",
      description: "Extract API endpoints, HTTP methods, response codes, and payload hints from a document or section.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeApiSurfaceQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("API surface", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_operational_notes",
    {
      title: "Extract Operational Notes",
      description: "Extract troubleshooting notes, warnings, runtime caveats, and operational hints from a document or section.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeOperationalNotesQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("Operational notes", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_risks",
    {
      title: "Extract Risks",
      description: "Extract risks, blockers, warnings, and critical issues from a document or section.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeRisksQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("Risks", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "extract_entities",
    {
      title: "Extract Entities",
      description: "Extract people, organizations, dates, contact data, and other named entities from a document or section.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeEntitiesQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatAnalysisResponse("Entities", payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "summarize_document",
    {
      title: "Summarize Document",
      description: "Create a server-side summary for a whole document, with optional focus query.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; query?: string }) => {
      const payload = await executeDocumentSummaryQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatSummaryResponse(payload) : "No matching document was found for the provided locator."
          }
        ]
      };
    }
  );

  server.registerTool(
    "summarize_document_section",
    {
      title: "Summarize Document Section",
      description: "Create a server-side summary for a specific document section or the best matching section for a query.",
      inputSchema: z.object({
        sourceRef: z.string().optional(),
        documentId: z.number().int().positive().optional(),
        sectionIndex: z.number().int().min(0).optional(),
        query: z.string().optional()
      })
    },
    async (args: { sourceRef?: string; documentId?: number; sectionIndex?: number; query?: string }) => {
      const payload = await executeSectionSummaryQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatSummaryResponse(payload) : "No matching document section was found for the provided locator or query."
          }
        ]
      };
    }
  );

  server.registerTool(
    "compare_documents",
    {
      title: "Compare Documents",
      description: "Compare two documents and summarize shared themes, differences, and action-item deltas.",
      inputSchema: z.object({
        leftDocumentId: z.number().int().positive().optional(),
        leftSourceRef: z.string().optional(),
        rightDocumentId: z.number().int().positive().optional(),
        rightSourceRef: z.string().optional()
      })
    },
    async (args: { leftDocumentId?: number; leftSourceRef?: string; rightDocumentId?: number; rightSourceRef?: string }) => {
      const payload = await executeCompareDocumentsQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatComparisonResponse(payload) : "One or both comparison documents could not be found."
          }
        ]
      };
    }
  );

  server.registerTool(
    "compare_document_versions",
    {
      title: "Compare Document Versions",
      description: "Compare a document with an earlier version, either explicitly or by automatically choosing the most likely previous version.",
      inputSchema: z.object({
        documentId: z.number().int().positive().optional(),
        sourceRef: z.string().optional(),
        previousDocumentId: z.number().int().positive().optional(),
        previousSourceRef: z.string().optional()
      })
    },
    async (args: { documentId?: number; sourceRef?: string; previousDocumentId?: number; previousSourceRef?: string }) => {
      const payload = await executeCompareDocumentVersionsQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: payload ? formatComparisonResponse(payload) : "No suitable previous document version was found for comparison."
          }
        ]
      };
    }
  );

  server.registerTool(
    "cross_reference",
    {
      title: "Cross Reference Topic",
      description: "Find sections across documents that reference the same topic, concept, or term.",
      inputSchema: z.object({
        topic: z.string().min(1),
        limit: z.number().int().min(1).max(25).default(12)
      })
    },
    async (args: { topic: string; limit: number }) => {
      const payload = await executeCrossReferenceQuery(withScope(args));
      return {
        content: [
          {
            type: "text",
            text: formatCrossReferenceResponse(payload)
          }
        ]
      };
    }
  );

  return server;
}

function applyMcpHeaders(response: express.Response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, mcp-session-id, Last-Event-ID, mcp-protocol-version"
  );
  response.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
}

function extractMcpToken(request: express.Request): string | null {
  const authorization = request.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim() || null;
  }

  const apiKey = request.header("x-api-key");
  return apiKey?.trim() || null;
}

export function createMcpRouter() {
  const router = express.Router();

  router.use((request, response, next) => {
    applyMcpHeaders(response);

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    next();
  });

  router.use((request, response, next) => {
    if (request.method !== "POST") {
      next();
      return;
    }

    hasEnabledMcpPrincipals()
      .then(async (authenticationRequired) => {
        if (!authenticationRequired) {
          next();
          return;
        }

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
      })
      .catch(next);
  });

  router.get("/", (_request, response) => {
    response.json({
      name: "rag-ingestor-mcp",
      transport: "streamable-http",
      endpoint: "/mcp",
      health: "/mcp/health"
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
      const server = await createRagMcpServer(response.locals.mcpPrincipal ?? null);
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
      next(error);
    }
  });

  return router;
}

export { createRagMcpServer };