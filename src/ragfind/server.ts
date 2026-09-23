import express from "express";
import pinoHttp from "pino-http";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import hljs from "highlight.js";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { pool } from "../db/pool";
import type { KnowledgeBaseRecord } from "../services/adminAccessService";
import { executeSmartSearchQuery } from "../routes/api";
import { findDocument } from "../services/documentService";
import { getDocumentFile, getDocumentFilesByDocumentIds } from "../services/originalFileService";
import { resolveRagfindKnowledgeBaseScope } from "../services/ragfindSettingsService";

interface SearchSnippet {
  chunkId: number;
  score: number;
  snippet: string;
  pageStart: number | null;
  pageEnd: number | null;
  sectionIndex: number | null;
  sectionTitle: string | null;
}

interface SearchResultGroup {
  documentId: number;
  title: string;
  sourceRef: string;
  sourceType: string;
  sourceUrl: string | null;
  mimeType: string | null;
  fileType: string | null;
  isHtml: boolean;
  viewUrl: string;
  originalUrl: string | null;
  originalName: string | null;
  score: number;
  snippets: SearchSnippet[];
}

interface SupplementalSearchRow {
  document_id: number;
  title: string | null;
  source_type: string;
  source_ref: string;
  source_url: string | null;
  file_type: string | null;
  mime_type: string | null;
  extracted_text: string;
  match_score: number;
}

type ViewerKind = "html" | "markdown" | "code" | "text";

const VIEWER_CODE_FILE_TYPES = new Set([
  "js", "jsx", "ts", "tsx", "py", "java", "go", "rs", "rb", "php", "c", "cc", "cpp", "h", "hpp",
  "cs", "sh", "bash", "zsh", "json", "yml", "yaml", "toml", "ini", "cfg", "conf", "xml", "sql", "css", "scss", "less"
]);

const VIEWER_BINARY_FILE_TYPES = new Set([
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "ods", "odp", "rtf",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tif", "tiff", "ico",
  "mp3", "wav", "ogg", "m4a", "flac", "mp4", "mkv", "mov", "avi", "webm",
  "zip", "rar", "7z", "gz", "tar", "bz2"
]);

const VIEWER_BINARY_MIME_PREFIXES = [
  "image/",
  "audio/",
  "video/",
  "application/pdf"
];

const VIEWER_BINARY_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
  "application/zip",
  "application/x-zip-compressed",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
  "application/gzip",
  "application/x-tar"
]);

interface ViewerContent {
  title: string;
  sourceRef: string;
  sourceType: string;
  fileType: string | null;
  mimeType: string | null;
  kind: ViewerKind;
  rawText: string;
  renderedHtml: string;
  // Gesetzt, wenn eine gespeicherte HTML-Kopie existiert: der Rahmen laedt sie
  // dann ueber diese URL statt ueber srcdoc.
  pageUrl: string | null;
  sourceUrl: string | null;
  originalUrl: string | null;
  originalName: string | null;
}

const RAGFIND_STATIC_ROOT = path.resolve(process.cwd(), "public", "ragfind");
const RAGFIND_SCOPE_CACHE_TTL_MS = 60_000;

let ragfindScopeCache: { value: { knowledgeBaseIds: number[]; knowledgeBases: KnowledgeBaseRecord[] } | null; expiresAt: number } = {
  value: null,
  expiresAt: 0
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeSnippet(text: string, query: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (!flattened) {
    return "";
  }

  if (!query.trim()) {
    return flattened.slice(0, 320);
  }

  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3);

  let anchor = -1;
  for (const term of terms) {
    const index = flattened.toLowerCase().indexOf(term);
    if (index >= 0 && (anchor < 0 || index < anchor)) {
      anchor = index;
    }
  }

  if (anchor < 0) {
    return flattened.slice(0, 320);
  }

  const start = Math.max(0, anchor - 110);
  const end = Math.min(flattened.length, anchor + 210);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < flattened.length ? "..." : "";
  return `${prefix}${flattened.slice(start, end).trim()}${suffix}`;
}

function highlightSnippet(text: string, query: string): string {
  const normalized = normalizeSnippet(text, query);
  if (!normalized || !query.trim()) {
    return normalized;
  }

  const terms = [...new Set(
    query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 3)
  )];
  if (terms.length === 0) {
    return normalized;
  }

  const pattern = new RegExp(`(${terms.map((term) => escapeRegExp(term)).join("|")})`, "giu");
  return normalized.replace(pattern, "<mark>$1</mark>");
}

function normalizeSearchTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
  )];
}

async function findSupplementalDocuments(
  query: string,
  limit: number,
  allowedKnowledgeBaseIds: number[]
): Promise<SupplementalSearchRow[]> {
  const terms = normalizeSearchTerms(query);
  if (terms.length === 0) {
    return [];
  }

  const result = await pool.query<SupplementalSearchRow>(
    `
      WITH query_input AS (
        SELECT
          $1::text[] AS terms,
          lower(regexp_replace(array_to_string($1::text[], ' '), '[^[:alnum:]]+', ' ', 'g')) AS normalized_query
      ),
      term_matches AS (
        SELECT
          matched_documents.document_id,
          matched_documents.term,
          matched_documents.term_score
        FROM query_input qi
        CROSS JOIN LATERAL unnest(qi.terms) AS query_term(term)
        JOIN LATERAL (
          SELECT
            d.id AS document_id,
            query_term.term,
            CASE
              WHEN strpos(d.search_lookup_normalized, query_term.term) > 0 THEN 2.5
              ELSE 0.75
            END AS term_score,
            CASE
              WHEN strpos(d.search_lookup_normalized, query_term.term) > 0 THEN 1
              ELSE 0
            END AS exact_term_match,
            GREATEST(
              similarity(d.search_lookup_normalized, query_term.term),
              word_similarity(d.search_lookup_normalized, query_term.term)
            ) AS fuzzy_score
          FROM documents d
          WHERE (
              $2::bigint[] IS NULL
              OR (cardinality($2::bigint[]) > 0 AND d.knowledge_base_id = ANY($2::bigint[]))
            )
            AND (
              strpos(d.search_lookup_normalized, query_term.term) > 0
              OR (
                char_length(query_term.term) >= 4
                AND d.search_lookup_normalized % query_term.term
              )
            )
          ORDER BY exact_term_match DESC, fuzzy_score DESC, d.id DESC
          LIMIT GREATEST($3::integer * 8, 40)
        ) AS matched_documents ON TRUE
      ),
      candidate_documents AS (
        SELECT DISTINCT document_id
        FROM term_matches
      ),
      document_lookup AS (
        SELECT
          d.id,
          d.title,
          d.source_type,
          d.source_ref,
          d.source_url,
          d.file_type,
          d.mime_type,
          COALESCE(d.extracted_text, '') AS extracted_text,
          d.search_lookup_normalized AS normalized_lookup
        FROM documents d
        INNER JOIN candidate_documents cd ON cd.document_id = d.id
      )
      SELECT
        d.id AS document_id,
        d.title,
        d.source_type,
        d.source_ref,
        d.source_url,
        d.file_type,
        d.mime_type,
        d.extracted_text,
        COALESCE(SUM(tm.term_score), 0)
        + CASE
            WHEN d.normalized_lookup LIKE '%' || replace(qi.normalized_query, ' ', '%') || '%' THEN 2.0
            ELSE 0
          END AS match_score
      FROM document_lookup d
      CROSS JOIN query_input qi
      LEFT JOIN term_matches tm ON tm.document_id = d.id
      GROUP BY d.id, d.title, d.source_type, d.source_ref, d.source_url, d.file_type, d.mime_type, d.extracted_text, d.normalized_lookup, qi.normalized_query
      ORDER BY match_score DESC, d.id DESC
      LIMIT $3::integer
    `,
    [terms, allowedKnowledgeBaseIds, Math.max(limit, 1)]
  );

  return result.rows;
}

async function resolveRagfindScope(): Promise<{ knowledgeBaseIds: number[]; knowledgeBases: KnowledgeBaseRecord[] }> {
  const now = Date.now();
  if (ragfindScopeCache.value && ragfindScopeCache.expiresAt > now) {
    return ragfindScopeCache.value;
  }

  const scope = await resolveRagfindKnowledgeBaseScope();
  ragfindScopeCache = {
    value: scope,
    expiresAt: now + RAGFIND_SCOPE_CACHE_TTL_MS
  };
  return scope;
}

async function buildSearchResults(query: string, topK: number): Promise<{ knowledgeBases: KnowledgeBaseRecord[]; results: SearchResultGroup[] }> {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const scope = await resolveRagfindScope();
  timings.scopeResolutionMs = Date.now() - startedAt;
  const retrievalTopK = Math.min(Math.max(topK * 3, 18), 48);
  const retrievalStartedAt = Date.now();
  const payload = await executeSmartSearchQuery({
    query,
    topK: retrievalTopK,
    model: env.EMBEDDING_MODEL,
    enableSmallToBig: false,
    preferDocumentFocus: false,
    preferAdjacentSections: false,
    requireFocusTerms: false,
    allowedKnowledgeBaseIds: scope.knowledgeBaseIds
  });
  timings.smartSearchMs = Date.now() - retrievalStartedAt;

  const fileLookupStartedAt = Date.now();
  const fileMap = await getDocumentFilesByDocumentIds([...new Set(payload.items.map((item) => item.documentId))]);
  timings.fileLookupMs = Date.now() - fileLookupStartedAt;
  const grouped = new Map<number, SearchResultGroup>();

  for (const item of payload.items) {
    const existing = grouped.get(item.documentId);
    const file = fileMap.get(item.documentId) ?? null;
    const snippet: SearchSnippet = {
      chunkId: item.chunkId,
      score: item.score,
      snippet: highlightSnippet(item.content, query),
      pageStart: typeof item.metadata.pageStart === "number" ? item.metadata.pageStart : null,
      pageEnd: typeof item.metadata.pageEnd === "number" ? item.metadata.pageEnd : null,
      sectionIndex: typeof item.metadata.sectionIndex === "number" ? item.metadata.sectionIndex : null,
      sectionTitle: typeof item.metadata.sectionTitle === "string" ? item.metadata.sectionTitle : null,
    };

    if (existing) {
      existing.score = Math.max(existing.score, item.score);
      existing.snippets.push(snippet);
      continue;
    }

    grouped.set(item.documentId, {
      documentId: item.documentId,
      title: item.title ?? item.sourceRef,
      sourceRef: item.sourceRef,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl ?? null,
      mimeType: typeof item.metadata.mimeType === "string"
        ? item.metadata.mimeType
        : typeof item.metadata.mime_type === "string"
          ? item.metadata.mime_type
          : null,
      fileType: typeof item.metadata.fileType === "string"
        ? item.metadata.fileType
        : typeof item.metadata.file_type === "string"
          ? item.metadata.file_type
          : null,
      isHtml: item.sourceType.startsWith("crawl")
        || typeof item.metadata.mimeType === "string" && item.metadata.mimeType.includes("html")
        || typeof item.metadata.mime_type === "string" && item.metadata.mime_type.includes("html")
        || typeof item.metadata.fileType === "string" && item.metadata.fileType.toLowerCase() === "html"
        || typeof item.metadata.file_type === "string" && item.metadata.file_type.toLowerCase() === "html",
      viewUrl: `/view/${item.documentId}`,
      originalUrl: file ? `/api/documents/${item.documentId}/original` : null,
      originalName: file?.originalName ?? null,
      score: item.score,
      snippets: [snippet]
    });
  }

  if (grouped.size < topK) {
    const supplementalStartedAt = Date.now();
    const supplementalDocuments = await findSupplementalDocuments(query, topK * 4, scope.knowledgeBaseIds);
    const supplementalIds = supplementalDocuments
      .map((entry) => Number(entry.document_id))
      .filter((documentId) => !grouped.has(documentId));
    const supplementalFileMap = supplementalIds.length > 0
      ? await getDocumentFilesByDocumentIds(supplementalIds)
      : new Map<number, Awaited<ReturnType<typeof getDocumentFilesByDocumentIds>> extends Map<number, infer TValue> ? TValue : never>();

    for (const document of supplementalDocuments) {
      const documentId = Number(document.document_id);
      if (grouped.has(documentId)) {
        continue;
      }

      const file = supplementalFileMap.get(documentId) ?? null;
      grouped.set(documentId, {
        documentId,
        title: document.title ?? document.source_ref,
        sourceRef: document.source_ref,
        sourceType: document.source_type,
        sourceUrl: document.source_url ?? null,
        mimeType: document.mime_type ?? null,
        fileType: document.file_type ?? null,
        isHtml: document.source_type.startsWith("crawl")
          || (document.mime_type ?? "").includes("html")
          || ["html", "htm", "xhtml"].includes((document.file_type ?? "").toLowerCase()),
        viewUrl: `/view/${documentId}`,
        originalUrl: file ? `/api/documents/${documentId}/original` : null,
        originalName: file?.originalName ?? null,
        score: Number(document.match_score),
        snippets: [
          {
            chunkId: 0,
            score: Number(document.match_score),
            snippet: highlightSnippet(document.extracted_text || document.source_ref, query),
            pageStart: null,
            pageEnd: null,
            sectionIndex: null,
            sectionTitle: null
          }
        ]
      });

      if (grouped.size >= topK) {
        break;
      }
    }
    timings.supplementalMs = Date.now() - supplementalStartedAt;
  }

  logger.debug({
    query,
    topK,
    retrievalTopK,
    payloadItemCount: payload.items.length,
    groupedDocumentCount: grouped.size,
    timings: {
      ...timings,
      totalMs: Date.now() - startedAt
    }
  }, "ragfind search results built");

  return {
    knowledgeBases: scope.knowledgeBases,
    results: [...grouped.values()]
      .map((entry) => ({
        ...entry,
        snippets: entry.snippets
          .sort((left, right) => right.score - left.score)
          .slice(0, 4)
      }))
      .sort((left, right) => right.score - left.score)
          .slice(0, topK)
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextFileIfPresent(filePath: string | null | undefined): Promise<string | null> {
  if (!filePath) {
    return null;
  }

  if (!(await fileExists(filePath))) {
    return null;
  }

  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function detectViewerKind(document: NonNullable<Awaited<ReturnType<typeof findDocument>>>, rawText: string): ViewerKind {
  const fileType = document.fileType?.toLowerCase() ?? "";
  const mimeType = document.mimeType?.toLowerCase() ?? "";
  const sourceRef = document.sourceRef.toLowerCase();

  if (looksLikeHtmlDocument(document) || extractedTextLooksLikeMarkup(rawText)) {
    return "html";
  }

  if (["md", "markdown", "mdx"].includes(fileType) || mimeType.includes("markdown") || sourceRef.endsWith(".md") || sourceRef.endsWith(".markdown")) {
    return "markdown";
  }

  if (
    document.sourceType === "git"
    || VIEWER_CODE_FILE_TYPES.has(fileType)
    || mimeType.startsWith("text/") && fileType !== "txt"
  ) {
    return "code";
  }

  return "text";
}

function isViewerSupportedDocument(document: NonNullable<Awaited<ReturnType<typeof findDocument>>>): boolean {
  if (looksLikeHtmlDocument(document)) {
    return true;
  }

  const fileType = document.fileType?.toLowerCase() ?? "";
  const mimeType = document.mimeType?.toLowerCase() ?? "";
  const sourceRef = document.sourceRef.toLowerCase();

  if ([...VIEWER_BINARY_MIME_PREFIXES].some((prefix) => mimeType.startsWith(prefix))) {
    return false;
  }

  if (VIEWER_BINARY_MIME_TYPES.has(mimeType) || VIEWER_BINARY_FILE_TYPES.has(fileType)) {
    return false;
  }

  if (["md", "markdown", "mdx", "txt", "text"].includes(fileType)) {
    return true;
  }

  if (VIEWER_CODE_FILE_TYPES.has(fileType)) {
    return true;
  }

  if (sourceRef.endsWith(".md") || sourceRef.endsWith(".markdown") || sourceRef.endsWith(".txt")) {
    return true;
  }

  if (mimeType.includes("markdown") || mimeType.startsWith("text/")) {
    return true;
  }

  return document.sourceType === "git" || document.sourceType.startsWith("crawl");
}

function detectHighlightLanguage(sourceRef: string, fileType: string | null, mimeType: string | null): string | undefined {
  const extension = (fileType || sourceRef.split(".").pop() || "").toLowerCase();
  const mapping: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    cjs: "javascript",
    mjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    json: "json",
    css: "css",
    scss: "scss",
    less: "less",
    html: "xml",
    htm: "xml",
    xml: "xml",
    sql: "sql",
    toml: "ini",
    ini: "ini",
    cfg: "ini",
    conf: "ini"
  };

  if (mapping[extension]) {
    return mapping[extension];
  }

  if (mimeType?.includes("json")) {
    return "json";
  }
  if (mimeType?.includes("xml") || mimeType?.includes("html")) {
    return "xml";
  }

  return undefined;
}

function renderHighlightedCode(rawText: string, sourceRef: string, fileType: string | null, mimeType: string | null): string {
  const language = detectHighlightLanguage(sourceRef, fileType, mimeType);
  const highlighted = language && hljs.getLanguage(language)
    ? hljs.highlight(rawText, { language, ignoreIllegals: true }).value
    : hljs.highlightAuto(rawText).value;

  return `<pre class="viewer-code"><code class="hljs">${highlighted}</code></pre>`;
}

async function renderMarkdown(markdown: string): Promise<string> {
  const { marked } = await import("marked");
  return marked.parse(markdown, { async: false }) as string;
}

function renderPlainText(rawText: string): string {
  return `<pre class="viewer-text">${escapeHtml(rawText)}</pre>`;
}

function renderMultisourceViewerPage(viewer: ViewerContent): string {
  const payload = JSON.stringify({
    kind: viewer.kind,
    title: viewer.title,
    sourceRef: viewer.sourceRef,
    sourceType: viewer.sourceType,
    fileType: viewer.fileType,
    mimeType: viewer.mimeType,
    rawText: viewer.rawText,
    renderedHtml: viewer.renderedHtml,
    pageUrl: viewer.pageUrl,
    sourceUrl: viewer.sourceUrl,
    originalUrl: viewer.originalUrl,
    originalName: viewer.originalName
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(viewer.title)} | RAGfind</title>
    <style>
      :root {
        color-scheme: dark light;
        --bg: #f4efe6;
        --panel: rgba(255,255,255,0.84);
        --panel-strong: rgba(255,255,255,0.94);
        --border: rgba(15,23,42,0.1);
        --text: #16202a;
        --muted: #5c6774;
        --accent: #0d6e6e;
        --accent-soft: rgba(13,110,110,0.14);
        --raw-bg: #f8fafc;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0d1218;
          --panel: rgba(255,255,255,0.045);
          --panel-strong: rgba(255,255,255,0.06);
          --border: rgba(255,255,255,0.1);
          --text: #f4f7fb;
          --muted: #9cabba;
          --accent: #87d1c7;
          --accent-soft: rgba(135,209,199,0.16);
          --raw-bg: #0f1720;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(13,110,110,0.18), transparent 34%),
          radial-gradient(circle at top right, rgba(190,120,70,0.14), transparent 30%),
          var(--bg);
        color: var(--text);
        font-family: "Segoe UI", "Helvetica Neue", sans-serif;
      }
      .shell {
        max-width: 1360px;
        margin: 0 auto;
        padding: 28px 18px 40px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        margin-bottom: 18px;
      }
      .title {
        margin: 0;
        font-size: clamp(1.5rem, 2vw, 2.3rem);
        line-height: 1.1;
      }
      .meta {
        margin-top: 10px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid var(--border);
        background: var(--panel);
        border-radius: 999px;
        padding: 7px 12px;
        color: var(--muted);
        font-size: 0.82rem;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .action {
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--text);
        text-decoration: none;
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 0.9rem;
      }
      .source {
        margin: 0 0 18px;
        color: var(--muted);
        word-break: break-word;
      }
      .viewer {
        border: 1px solid var(--border);
        background: var(--panel-strong);
        border-radius: 24px;
        overflow: hidden;
        backdrop-filter: blur(14px);
      }
      .viewer-tabs {
        display: flex;
        gap: 10px;
        padding: 14px;
        border-bottom: 1px solid var(--border);
        background: var(--panel);
      }
      .viewer-tab {
        border: 1px solid var(--border);
        background: transparent;
        color: var(--muted);
        border-radius: 999px;
        padding: 9px 14px;
        cursor: pointer;
        font: inherit;
      }
      .viewer-tab.active {
        background: var(--accent-soft);
        color: var(--text);
        border-color: rgba(13,110,110,0.34);
      }
      .viewer-pane {
        display: none;
        min-height: 70vh;
      }
      .viewer-pane.active {
        display: block;
      }
      .viewer-rendered {
        padding: 24px;
      }
      .viewer-rendered.markdown {
        max-width: 900px;
        margin: 0 auto;
        line-height: 1.7;
      }
      .viewer-rendered.markdown h1,
      .viewer-rendered.markdown h2,
      .viewer-rendered.markdown h3 {
        line-height: 1.2;
      }
      .viewer-rendered.markdown pre,
      .viewer-rendered.markdown code,
      .viewer-code,
      .viewer-text,
      .viewer-raw {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      .viewer-rendered.markdown pre,
      .viewer-code,
      .viewer-text,
      .viewer-raw {
        margin: 0;
        padding: 22px;
        overflow: auto;
        background: var(--raw-bg);
      }
      .viewer-text,
      .viewer-raw {
        white-space: pre-wrap;
        word-break: break-word;
      }
      .viewer-raw-shell {
        padding: 0;
      }
      .source a {
        color: var(--accent);
        text-decoration: none;
        border-bottom: 1px solid var(--accent-soft);
      }
      .source a:hover { border-bottom-color: var(--accent); }
      .viewer-iframe {
        width: 100%;
        min-height: 78vh;
        border: 0;
        background: white;
      }
      .hljs-comment,
      .hljs-quote { color: #64748b; }
      .hljs-keyword,
      .hljs-selector-tag,
      .hljs-literal { color: #0f766e; }
      .hljs-string,
      .hljs-doctag,
      .hljs-regexp { color: #9a3412; }
      .hljs-title,
      .hljs-section,
      .hljs-name { color: #1d4ed8; }
      .hljs-number,
      .hljs-symbol,
      .hljs-bullet { color: #7c3aed; }
      @media (prefers-color-scheme: dark) {
        .hljs-comment,
        .hljs-quote { color: #94a3b8; }
        .hljs-keyword,
        .hljs-selector-tag,
        .hljs-literal { color: #7dd3fc; }
        .hljs-string,
        .hljs-doctag,
        .hljs-regexp { color: #fdba74; }
        .hljs-title,
        .hljs-section,
        .hljs-name { color: #c4b5fd; }
        .hljs-number,
        .hljs-symbol,
        .hljs-bullet { color: #f9a8d4; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="header">
        <div>
          <h1 class="title">${escapeHtml(viewer.title)}</h1>
          <div class="meta">
            <span class="badge">${escapeHtml(viewer.sourceType)}</span>
            ${viewer.fileType ? `<span class="badge">.${escapeHtml(viewer.fileType)}</span>` : ""}
            ${viewer.mimeType ? `<span class="badge">${escapeHtml(viewer.mimeType)}</span>` : ""}
            <span class="badge">Lokaler Multi-Source-Viewer</span>
          </div>
        </div>
        <div class="actions">
          <a class="action" href="/">Zur Suche</a>
          ${viewer.sourceUrl ? `<a class="action" href="${escapeHtml(viewer.sourceUrl)}" target="_blank" rel="noreferrer noopener">Originalseite &#8599;</a>` : ""}
          ${viewer.originalUrl ? `<a class="action" href="${escapeHtml(viewer.originalUrl)}" target="_blank" rel="noreferrer">${viewer.pageUrl ? "Gespeicherte Kopie" : "Originaldatei"}</a>` : ""}
        </div>
      </div>
      <p class="source">${
        viewer.sourceUrl
          ? `<a href="${escapeHtml(viewer.sourceUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(viewer.sourceRef)}</a>`
          : escapeHtml(viewer.sourceRef)
      }</p>

      <section class="viewer">
        <div class="viewer-tabs">
          <button class="viewer-tab active" data-tab="rendered">Ansicht</button>
          <button class="viewer-tab" data-tab="raw">Plaintext</button>
        </div>
        <div id="pane-rendered" class="viewer-pane active"></div>
        <div id="pane-raw" class="viewer-pane viewer-raw-shell"></div>
      </section>
    </div>
    <script>
      const payload = ${payload};
      const renderedPane = document.getElementById("pane-rendered");
      const rawPane = document.getElementById("pane-raw");
      const tabs = [...document.querySelectorAll(".viewer-tab")];

      if (payload.pageUrl) {
        const iframe = document.createElement("iframe");
        iframe.className = "viewer-iframe";
        // Weder allow-scripts noch allow-same-origin: der Rahmen zeigt fremdes,
        // gecrawltes HTML. Zusammen heben diese beiden Werte die Sandbox
        // gegenseitig auf - der Inhalt koennte dann auf das RAGfind-Dokument
        // zugreifen. Ohne sie bekommt der Rahmen einen eigenen, leeren Ursprung
        // und fuehrt nichts aus; Stylesheets, Bilder und Schriften laedt er
        // weiterhin. allow-popups erlaubt, dass ein Link der Kopie die echte
        // Seite in einem neuen Tab oeffnet.
        iframe.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
        iframe.setAttribute("referrerpolicy", "no-referrer");
        iframe.src = payload.pageUrl;
        renderedPane.appendChild(iframe);
      } else {
        renderedPane.className = "viewer-pane active viewer-rendered " + payload.kind;
        renderedPane.innerHTML = payload.renderedHtml;
      }

      const rawPre = document.createElement("pre");
      rawPre.className = "viewer-raw";
      rawPre.textContent = payload.rawText;
      rawPane.replaceChildren(rawPre);

      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          tabs.forEach((candidate) => candidate.classList.toggle("active", candidate === tab));
          document.getElementById("pane-rendered").classList.toggle("active", tab.dataset.tab === "rendered");
          document.getElementById("pane-raw").classList.toggle("active", tab.dataset.tab === "raw");
        });
      });
    </script>
  </body>
</html>`;
}

async function buildViewerContent(document: NonNullable<Awaited<ReturnType<typeof findDocument>>>): Promise<ViewerContent> {
  const file = await getDocumentFile(document.id);
  const absolutePath = file?.relativePath ? path.join(env.ORIGINAL_STORAGE_DIR, file.relativePath) : null;
  const localText = await readTextFileIfPresent(absolutePath);
  const kind = detectViewerKind(document, localText ?? document.extractedText);

  // Bei HTML sind das zwei verschiedene Dinge mit je eigenem Tab: die
  // gespeicherte Datei ist die Seite ("Ansicht"), der extrahierte Text ist die
  // lesbare Fassung ("Plaintext"). Wuerde hier wie bei allen anderen Arten die
  // lokale Datei fuer beides genommen, zeigte der Plaintext-Tab bei gecrawlten
  // Seiten HTML-Quelltext statt Text.
  const hasStoredPage = kind === "html" && localText !== null;
  const rawText = hasStoredPage ? document.extractedText : (localText ?? document.extractedText);

  let renderedHtml = "";
  if (hasStoredPage) {
    // Die Seite wird NICHT eingebettet, sondern vom Endpunkt unten geladen.
    // Ueber srcdoc erbt der Rahmen die CSP des Elterndokuments und hat keine
    // eigene Adresse - beides sorgt dafuer, dass externe Stylesheets und Bilder
    // je nach Umgebung stillschweigend wegfallen. Mit eigener URL laedt der
    // Browser Unterresourcen normal, und der Endpunkt setzt eine passende CSP.
    renderedHtml = "";
  } else if (kind === "html") {
    // Kein gespeichertes HTML - etwa bei Seiten, die vor dessen Einfuehrung
    // gecrawlt wurden. Dann gibt es nur den extrahierten Text; als Textansicht
    // ist er wenigstens lesbar. Styling laesst sich nicht rekonstruieren, die
    // Seite wurde damals nie gespeichert.
    renderedHtml = renderPlainText(document.extractedText);
  } else if (kind === "markdown") {
    renderedHtml = await renderMarkdown(rawText);
  } else if (kind === "code") {
    renderedHtml = renderHighlightedCode(rawText, document.sourceRef, document.fileType, document.mimeType);
  } else {
    renderedHtml = renderPlainText(rawText);
  }

  return {
    title: document.title ?? document.sourceRef,
    sourceRef: document.sourceRef,
    sourceType: document.sourceType,
    fileType: document.fileType,
    mimeType: document.mimeType,
    kind,
    rawText,
    renderedHtml,
    pageUrl: hasStoredPage ? `/view/${document.id}/page` : null,
    sourceUrl: document.sourceUrl ?? (/^https?:\/\//i.test(document.sourceRef) ? document.sourceRef : null),
    originalUrl: file ? `/api/documents/${document.id}/original` : null,
    originalName: file?.originalName ?? null
  };
}

function looksLikeHtmlDocument(document: Awaited<ReturnType<typeof findDocument>>): boolean {
  if (!document) {
    return false;
  }

  if (document.sourceType.startsWith("crawl")) {
    return true;
  }

  const mimeType = document.mimeType?.toLowerCase() ?? "";
  const fileType = document.fileType?.toLowerCase() ?? "";
  if (mimeType.includes("html") || ["html", "htm", "xhtml"].includes(fileType)) {
    return true;
  }

  const extractedTextStart = document.extractedText.slice(0, 500).toLowerCase();
  return extractedTextStart.includes("<html") || extractedTextStart.includes("<!doctype html") || extractedTextStart.includes("<body");
}

function extractedTextLooksLikeMarkup(text: string): boolean {
  const normalized = text.slice(0, 500).trim().toLowerCase();
  return normalized.includes("<html") || normalized.includes("<!doctype html") || normalized.includes("<body") || normalized.includes("<div") || normalized.includes("<main");
}

function renderExtractedTextPage(title: string, extractedText: string): string {
  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
  const escapedText = extractedText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        background: #f5f1e8;
        color: #1f2328;
      }
      main {
        max-width: 980px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 2rem;
      }
      p {
        margin: 0 0 24px;
        color: #5b6470;
      }
      pre {
        margin: 0;
        padding: 24px;
        white-space: pre-wrap;
        word-break: break-word;
        background: rgba(255, 255, 255, 0.82);
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 18px;
        font: 16px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      @media (prefers-color-scheme: dark) {
        body {
          background: #10151d;
          color: #f2f5f8;
        }
        p {
          color: #a7b0bc;
        }
        pre {
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.08);
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapedTitle}</h1>
      <p>Lokale gespeicherte Kopie aus RAGfind.</p>
      <pre>${escapedText}</pre>
    </main>
  </body>
</html>`;
}

async function start() {
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/meta", async (_request, response, next) => {
    try {
      const scope = await resolveRagfindScope();
      response.json({
        productName: "RAGfind",
        knowledgeBases: scope.knowledgeBases.map((knowledgeBase) => ({
          id: knowledgeBase.id,
          slug: knowledgeBase.slug,
          name: knowledgeBase.name,
          documentCount: knowledgeBase.documentCount
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/search", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").trim();
      const topKRaw = Number(request.query.topK ?? 12);
      const topK = Math.min(Math.max(Number.isFinite(topKRaw) ? topKRaw : 12, 1), 20);
      if (query.length < 2) {
        response.status(400).json({ error: "query must contain at least 2 characters" });
        return;
      }

      const startedAt = Date.now();
      const { knowledgeBases, results } = await buildSearchResults(query, topK);
      response.json({
        query,
        productName: "RAGfind",
        searchScope: {
          knowledgeBaseIds: knowledgeBases.map((entry) => entry.id),
          knowledgeBaseSlugs: knowledgeBases.map((entry) => entry.slug),
          knowledgeBaseNames: knowledgeBases.map((entry) => entry.name)
        },
        resultCount: results.length,
        tookMs: Date.now() - startedAt,
        results
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/documents/:documentId/original", async (request, response, next) => {
    try {
      const documentId = Number(request.params.documentId);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "invalid document id" });
        return;
      }

      const scope = await resolveRagfindScope();
      const document = await findDocument({
        documentId,
        allowedKnowledgeBaseIds: scope.knowledgeBaseIds
      });
      if (!document) {
        response.status(404).json({ error: "document not found in configured RAGfind knowledge bases" });
        return;
      }

      const file = await getDocumentFile(document.id);
      const forceDownload = String(request.query.download ?? "").trim() === "1";
      if (!file) {
        if (document.sourceType.startsWith("crawl")) {
          if (looksLikeHtmlDocument(document) || extractedTextLooksLikeMarkup(document.extractedText)) {
            response.type("text/html; charset=utf-8");
            response.send(document.extractedText);
            return;
          }

          response.type("text/html; charset=utf-8");
          response.send(renderExtractedTextPage(document.title || document.sourceRef, document.extractedText));
          return;
        }

        response.status(404).json({ error: "no original file available" });
        return;
      }

      if (!file.relativePath) {
        if (document.sourceType.startsWith("crawl")) {
          if (looksLikeHtmlDocument(document) || extractedTextLooksLikeMarkup(document.extractedText)) {
            response.type("text/html; charset=utf-8");
            response.send(document.extractedText);
            return;
          }

          response.type("text/html; charset=utf-8");
          response.send(renderExtractedTextPage(document.title || document.sourceRef, document.extractedText));
          return;
        }

        response.status(404).json({ error: "no local original file available" });
        return;
      }

      const absolutePath = path.join(env.ORIGINAL_STORAGE_DIR, file.relativePath);
      if (!(await fileExists(absolutePath))) {
        response.status(404).json({ error: "stored original file is missing" });
        return;
      }

      if (file.mimeType) {
        response.type(file.mimeType);
      }
      if (file.originalName) {
        const disposition = forceDownload ? "attachment" : "inline";
        response.setHeader("Content-Disposition", `${disposition}; filename="${file.originalName.replace(/\"/g, "")}"`);
      }
      response.sendFile(absolutePath);
    } catch (error) {
      next(error);
    }
  });

  app.get("/view/:documentId", async (request, response, next) => {
    try {
      const documentId = Number(request.params.documentId);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "invalid document id" });
        return;
      }

      const scope = await resolveRagfindScope();
      const document = await findDocument({
        documentId,
        allowedKnowledgeBaseIds: scope.knowledgeBaseIds
      });
      if (!document) {
        response.status(404).json({ error: "document not found in configured RAGfind knowledge bases" });
        return;
      }

      if (!isViewerSupportedDocument(document)) {
        response.redirect(`/api/documents/${document.id}/original?download=1`);
        return;
      }

      const viewer = await buildViewerContent(document);
      response.type("text/html; charset=utf-8");
      response.send(renderMultisourceViewerPage(viewer));
    } catch (error) {
      next(error);
    }
  });

  // Liefert die gespeicherte HTML-Kopie einer gecrawlten Seite aus, damit der
  // Rahmen im Viewer sie ueber eine echte Adresse laden kann.
  //
  // Die CSP ist der eigentliche Schutz: Skripte sind verboten, Stylesheets,
  // Bilder, Schriften und Medien duerfen von ueberall kommen - sonst waere die
  // Kopie eine Textwueste. Das serverseitige Entfernen der Skripte beim
  // Speichern bleibt als zweite Schicht, ebenso die Sandbox am Rahmen.
  app.get("/view/:documentId/page", async (request, response, next) => {
    try {
      const documentId = Number(request.params.documentId);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "invalid document id" });
        return;
      }

      const scope = await resolveRagfindScope();
      const document = await findDocument({
        documentId,
        allowedKnowledgeBaseIds: scope.knowledgeBaseIds
      });
      if (!document) {
        response.status(404).json({ error: "document not found in configured RAGfind knowledge bases" });
        return;
      }

      const file = await getDocumentFile(document.id);
      const absolutePath = file?.relativePath ? path.join(env.ORIGINAL_STORAGE_DIR, file.relativePath) : null;
      const storedPage = await readTextFileIfPresent(absolutePath);
      if (!storedPage) {
        response.status(404).json({ error: "no stored page available for this document" });
        return;
      }

      response.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'none'",
          "script-src 'none'",
          "style-src * 'unsafe-inline'",
          "img-src * data: blob:",
          "font-src * data:",
          "media-src *",
          "form-action 'none'",
          "frame-ancestors 'self'"
        ].join("; ")
      );
      response.setHeader("X-Content-Type-Options", "nosniff");
      // Die Originalseite soll nicht erfahren, aus welchem Archiv der Abruf kommt.
      response.setHeader("Referrer-Policy", "no-referrer");
      response.type("text/html; charset=utf-8");
      response.send(storedPage);
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(RAGFIND_STATIC_ROOT));
  app.get("*", (_request, response) => {
    response.sendFile(path.join(RAGFIND_STATIC_ROOT, "index.html"));
  });

  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    logger.error({ err: error }, "ragfind request failed");
    response.status(500).json({ error: error.message || "internal server error" });
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "ragfind listening");
  });

  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  logger.error({ err: error }, "failed to start ragfind");
  process.exit(1);
});