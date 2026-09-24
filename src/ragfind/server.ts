import express from "express";
import pinoHttp from "pino-http";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { pool } from "../db/pool";
import type { KnowledgeBaseRecord } from "../services/adminAccessService";
import { executeSmartSearchQuery } from "../routes/api";
import { findDocument } from "../services/documentService";
import { getDocumentFile, getDocumentFilesByDocumentIds } from "../services/originalFileService";
import { resolveRagfindKnowledgeBaseScope } from "../services/ragfindSettingsService";
import { ensurePdfRendition, ensurePdfThumbnail, isOfficeConvertible, isPdfFile } from "./derivedAssets";
import { fetchRemoteAsset, rewriteCssUrls, rewriteStoredPage } from "./assetProxy";
import { absoluteFilePath, buildViewerPayload, isWebPageDocument, previewKindFor, type PresentationKind } from "./viewerModel";
import { renderExtractedTextPage, renderViewerShell } from "./viewerPage";

interface SearchSnippet {
  chunkId: number;
  score: number;
  snippet: string;
  text: string;
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
  documentType: string | null;
  summary: string | null;
  knowledgeBaseName: string | null;
  updatedAt: string | null;
  fileSizeBytes: number | null;
  previewKind: PresentationKind;
  thumbUrl: string | null;
  viewUrl: string;
  originalUrl: string | null;
  downloadUrl: string | null;
  originalName: string | null;
  score: number;
  snippets: SearchSnippet[];
}

interface FacetEntry {
  value: string;
  count: number;
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

interface DocumentSummaryRow {
  id: number;
  title: string | null;
  source_type: string;
  source_ref: string;
  source_url: string | null;
  file_type: string | null;
  mime_type: string | null;
  updated_at: string | null;
  document_type: string | null;
  summary: string | null;
  knowledge_base_name: string | null;
}

const RAGFIND_STATIC_ROOT = path.resolve(process.cwd(), "public", "ragfind");
const PDFJS_ROOT = path.dirname(require.resolve("pdfjs-dist/package.json"));
const RAGFIND_SCOPE_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_TTL_MS = 5 * 60_000;
const SEARCH_CACHE_MAX_ENTRIES = 60;
const SEARCH_RESULT_LIMIT = 40;

let ragfindScopeCache: { value: { knowledgeBaseIds: number[]; knowledgeBases: KnowledgeBaseRecord[] } | null; expiresAt: number } = {
  value: null,
  expiresAt: 0
};

// Eine Suche kostet mehrere Sekunden, fast alles davon das Embedding der
// Anfrage. Wer einen Treffer oeffnet und zurueckgeht, soll nicht erneut warten.
const searchCache = new Map<string, { expiresAt: number; payload: unknown }>();

function readSearchCache(key: string): unknown | null {
  const entry = searchCache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    searchCache.delete(key);
    return null;
  }

  return entry.payload;
}

function writeSearchCache(key: string, payload: unknown): void {
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey !== undefined) {
      searchCache.delete(oldestKey);
    }
  }
  searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, payload });
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function escapeSnippetHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightSnippet(text: string, query: string): string {
  // Der Ausschnitt stammt aus dem Dokument und landet in der Trefferliste als
  // HTML - Markup daraus muss entschaerft sein, bevor die Suchbegriffe
  // ausgezeichnet werden. Sonst brauechte nur eine gecrawlte Seite ein
  // script-Tag im Text zu haben.
  const normalized = escapeSnippetHtml(normalizeSnippet(text, query));
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


function stripHighlightMarkup(value: string): string {
  return value.replace(/<\/?mark>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function buildViewUrl(documentId: number, query: string): string {
  const params = new URLSearchParams();
  if (query.trim()) {
    params.set("q", query.trim());
  }
  const suffix = params.toString();
  return suffix ? `/view/${documentId}?${suffix}` : `/view/${documentId}`;
}

async function loadDocumentSummaries(documentIds: number[]): Promise<Map<number, DocumentSummaryRow>> {
  if (documentIds.length === 0) {
    return new Map();
  }

  const result = await pool.query<DocumentSummaryRow>(
    `
      SELECT
        d.id,
        d.title,
        d.source_type,
        d.source_ref,
        d.source_url,
        d.file_type,
        d.mime_type,
        d.updated_at::text AS updated_at,
        d.metadata->>'documentType' AS document_type,
        d.metadata->'classification'->>'summary' AS summary,
        kb.name AS knowledge_base_name
      FROM documents d
      LEFT JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
      WHERE d.id = ANY($1::bigint[])
    `,
    [documentIds]
  );

  return new Map(result.rows.map((row) => [Number(row.id), row]));
}

function countFacet(values: (string | null)[]): FacetEntry[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = (value ?? "").trim();
    if (!normalized) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

// Nur bei null Treffern: das aehnlichste Wort aus Titeln und Dateinamen. Der
// Bestand ist klein genug, dass sich dafuer kein eigenes Woerterbuch lohnt.
async function findSpellingSuggestion(query: string, allowedKnowledgeBaseIds: number[]): Promise<string | null> {
  const terms = normalizeSearchTerms(query).filter((term) => term.length >= 4);
  if (terms.length === 0) {
    return null;
  }

  try {
    const result = await pool.query<{ suggestion: string }>(
      `
        WITH vocabulary AS (
          SELECT DISTINCT lower(word) AS word
          FROM documents d
          CROSS JOIN LATERAL regexp_split_to_table(
            COALESCE(d.title, '') || ' ' || d.source_ref,
            '[^[:alnum:]]+'
          ) AS word
          WHERE (
              $2::bigint[] IS NULL
              OR (cardinality($2::bigint[]) > 0 AND d.knowledge_base_id = ANY($2::bigint[]))
            )
            AND char_length(word) >= 4
        )
        SELECT word AS suggestion
        FROM vocabulary, unnest($1::text[]) AS term
        WHERE similarity(word, term) > 0.42
        ORDER BY similarity(word, term) DESC
        LIMIT 1
      `,
      [terms, allowedKnowledgeBaseIds]
    );

    const suggestion = result.rows[0]?.suggestion ?? null;
    return suggestion && !terms.includes(suggestion) ? suggestion : null;
  } catch (error) {
    logger.debug({ err: error }, "spelling suggestion failed");
    return null;
  }
}

async function buildSearchResults(query: string, limit: number): Promise<{
  knowledgeBases: KnowledgeBaseRecord[];
  results: SearchResultGroup[];
  facets: Record<string, FacetEntry[]>;
  suggestion: string | null;
}> {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const scope = await resolveRagfindScope();
  timings.scopeResolutionMs = Date.now() - startedAt;
  const retrievalTopK = Math.min(Math.max(limit * 3, 24), 90);
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

  const grouped = new Map<number, { score: number; snippets: SearchSnippet[] }>();
  for (const item of payload.items) {
    const highlighted = highlightSnippet(item.content, query);
    const snippet: SearchSnippet = {
      chunkId: item.chunkId,
      score: item.score,
      snippet: highlighted,
      text: stripHighlightMarkup(highlighted),
      pageStart: typeof item.metadata.pageStart === "number" ? item.metadata.pageStart : null,
      pageEnd: typeof item.metadata.pageEnd === "number" ? item.metadata.pageEnd : null,
      sectionIndex: typeof item.metadata.sectionIndex === "number" ? item.metadata.sectionIndex : null,
      sectionTitle: typeof item.metadata.sectionTitle === "string" ? item.metadata.sectionTitle : null
    };

    const existing = grouped.get(item.documentId);
    if (existing) {
      existing.score = Math.max(existing.score, item.score);
      existing.snippets.push(snippet);
      continue;
    }

    grouped.set(item.documentId, { score: item.score, snippets: [snippet] });
  }

  // Die Vektorsuche findet nur, was schon eingebettet ist. Der Zusatzlauf holt
  // Dokumente dazu, die nur ueber Titel oder Dateiname passen.
  if (grouped.size < limit) {
    const supplementalStartedAt = Date.now();
    const supplementalDocuments = await findSupplementalDocuments(query, limit * 2, scope.knowledgeBaseIds);
    for (const document of supplementalDocuments) {
      const documentId = Number(document.document_id);
      if (grouped.has(documentId)) {
        continue;
      }

      const highlighted = highlightSnippet(document.extracted_text || document.source_ref, query);
      grouped.set(documentId, {
        score: Number(document.match_score),
        snippets: [{
          chunkId: 0,
          score: Number(document.match_score),
          snippet: highlighted,
          text: stripHighlightMarkup(highlighted),
          pageStart: null,
          pageEnd: null,
          sectionIndex: null,
          sectionTitle: null
        }]
      });

      if (grouped.size >= limit) {
        break;
      }
    }
    timings.supplementalMs = Date.now() - supplementalStartedAt;
  }

  const documentIds = [...grouped.keys()];
  const lookupStartedAt = Date.now();
  const [fileMap, summaryMap] = await Promise.all([
    getDocumentFilesByDocumentIds(documentIds),
    loadDocumentSummaries(documentIds)
  ]);
  timings.documentLookupMs = Date.now() - lookupStartedAt;

  const results: SearchResultGroup[] = [];
  for (const [documentId, entry] of grouped) {
    const summary = summaryMap.get(documentId);
    const file = fileMap.get(documentId) ?? null;
    const fileType = summary?.file_type ?? null;
    const mimeType = summary?.mime_type ?? null;
    const sourceType = summary?.source_type ?? "unbekannt";
    const previewKind = previewKindFor({ sourceType, fileType, mimeType });
    const hasLocalFile = Boolean(file?.relativePath);

    results.push({
      documentId,
      title: summary?.title ?? summary?.source_ref ?? `Dokument ${documentId}`,
      sourceRef: summary?.source_ref ?? "",
      sourceType,
      sourceUrl: summary?.source_url ?? null,
      mimeType,
      fileType,
      documentType: summary?.document_type ?? null,
      summary: summary?.summary ?? null,
      knowledgeBaseName: summary?.knowledge_base_name ?? null,
      updatedAt: summary?.updated_at ?? null,
      fileSizeBytes: file?.fileSizeBytes ?? null,
      previewKind,
      // Vorschaubilder gibt es nur, wo sich wirklich eins erzeugen laesst -
      // sonst fragt die Trefferliste lauter 404 ab.
      thumbUrl: hasLocalFile && (previewKind === "pdf" || previewKind === "image")
        ? `/view/${documentId}/thumb`
        : null,
      viewUrl: buildViewUrl(documentId, query),
      originalUrl: file ? `/api/documents/${documentId}/original` : null,
      downloadUrl: file ? `/api/documents/${documentId}/original?download=1` : null,
      originalName: file?.originalName ?? null,
      score: entry.score,
      snippets: entry.snippets.sort((left, right) => right.score - left.score).slice(0, 4)
    });
  }

  results.sort((left, right) => right.score - left.score);
  const limited = results.slice(0, limit);

  const facets = {
    documentTypes: countFacet(limited.map((entry) => entry.documentType)),
    knowledgeBases: countFacet(limited.map((entry) => entry.knowledgeBaseName)),
    fileTypes: countFacet(limited.map((entry) => entry.fileType)),
    sourceTypes: countFacet(limited.map((entry) => entry.sourceType))
  };

  const suggestion = limited.length === 0
    ? await findSpellingSuggestion(query, scope.knowledgeBaseIds)
    : null;

  logger.debug({
    query,
    limit,
    retrievalTopK,
    payloadItemCount: payload.items.length,
    groupedDocumentCount: grouped.size,
    timings: { ...timings, totalMs: Date.now() - startedAt }
  }, "ragfind search results built");

  return { knowledgeBases: scope.knowledgeBases, results: limited, facets, suggestion };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveScopedDocument(documentIdRaw: string) {
  const documentId = Number(documentIdRaw);
  if (!Number.isFinite(documentId) || documentId <= 0) {
    return { status: 400 as const, error: "invalid document id", document: null };
  }

  const scope = await resolveRagfindScope();
  const document = await findDocument({ documentId, allowedKnowledgeBaseIds: scope.knowledgeBaseIds });
  if (!document) {
    return { status: 404 as const, error: "document not found in configured RAGfind knowledge bases", document: null };
  }

  return { status: 200 as const, error: null, document };
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
          name: knowledgeBase.name
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/search", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").trim();
      const limitRaw = Number(request.query.limit ?? SEARCH_RESULT_LIMIT);
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : SEARCH_RESULT_LIMIT, 1), 60);
      if (query.length < 2) {
        response.status(400).json({ error: "query must contain at least 2 characters" });
        return;
      }

      const cacheKey = `${query.toLowerCase()}|${limit}`;
      const cached = readSearchCache(cacheKey);
      if (cached) {
        response.json({ ...(cached as Record<string, unknown>), cached: true });
        return;
      }

      const startedAt = Date.now();
      const { knowledgeBases, results, facets, suggestion } = await buildSearchResults(query, limit);
      const payload = {
        query,
        productName: "RAGfind",
        searchScope: {
          knowledgeBaseIds: knowledgeBases.map((entry) => entry.id),
          knowledgeBaseSlugs: knowledgeBases.map((entry) => entry.slug),
          knowledgeBaseNames: knowledgeBases.map((entry) => entry.name)
        },
        resultCount: results.length,
        tookMs: Date.now() - startedAt,
        facets,
        suggestion,
        cached: false,
        results
      };

      writeSearchCache(cacheKey, payload);
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/documents/:documentId/original", async (request, response, next) => {
    try {
      const resolved = await resolveScopedDocument(request.params.documentId);
      if (!resolved.document) {
        response.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const document = resolved.document;
      const file = await getDocumentFile(document.id);
      const forceDownload = String(request.query.download ?? "").trim() === "1";

      if (!file?.relativePath) {
        // Gecrawlte Seiten ohne lokale Kopie: statt 404 wenigstens den Text.
        if (document.sourceType.startsWith("crawl")) {
          response.type("text/html; charset=utf-8");
          response.send(isWebPageDocument(document) && /<\w+[\s>]/.test(document.extractedText.slice(0, 500))
            ? document.extractedText
            : renderExtractedTextPage(document.title || document.sourceRef, document.extractedText));
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
        response.setHeader("Content-Disposition", `${disposition}; filename="${file.originalName.replace(/"/g, "")}"`);
      }
      response.sendFile(absolutePath);
    } catch (error) {
      next(error);
    }
  });

  // Die Ansicht des Dokuments. Anders als frueher leitet sie nie auf einen
  // Download um: jedes Format bekommt die Darstellung, die zu ihm passt, und
  // notfalls eine Karte mit Dateiangaben statt eines stillen Downloads.
  app.get("/view/:documentId", async (request, response, next) => {
    try {
      const resolved = await resolveScopedDocument(request.params.documentId);
      if (!resolved.document) {
        response.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const file = await getDocumentFile(resolved.document.id);
      const viewer = await buildViewerPayload(resolved.document, file, {
        query: String(request.query.q ?? "").trim(),
        highlight: String(request.query.hl ?? "").trim()
      });

      response.type("text/html; charset=utf-8");
      response.send(renderViewerShell(viewer));
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
      const resolved = await resolveScopedDocument(request.params.documentId);
      if (!resolved.document) {
        response.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const document = resolved.document;
      const file = await getDocumentFile(document.id);
      const absolutePath = absoluteFilePath(file);
      if (!absolutePath || !(await fileExists(absolutePath))) {
        response.status(404).json({ error: "no stored page available for this document" });
        return;
      }

      response.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'none'",
          "script-src 'none'",
          // Nachgeladenes laeuft ueber /view/:id/asset und ist damit
          // gleicher Herkunft. Fremde Adressen bleiben erlaubt, damit eine
          // Kopie mit uebersehenem Verweis nicht schlechter aussieht als
          // vorher.
          "style-src 'self' * 'unsafe-inline'",
          "img-src 'self' * data: blob:",
          "font-src 'self' * data:",
          "media-src 'self' *",
          "form-action 'none'",
          "frame-ancestors 'self'"
        ].join("; ")
      );
      response.setHeader("X-Content-Type-Options", "nosniff");
      // Die Originalseite soll nicht erfahren, aus welchem Archiv der Abruf kommt.
      response.setHeader("Referrer-Policy", "no-referrer");
      response.type("text/html; charset=utf-8");

      const storedPage = await readFile(absolutePath, "utf8");
      const pageUrl = document.sourceUrl ?? document.sourceRef;
      response.send(rewriteStoredPage(storedPage, pageUrl, document.id));
    } catch (error) {
      next(error);
    }
  });

  // Holt ein Stylesheet, Bild oder eine Schrift, auf die eine gespeicherte
  // Seite verweist, und liefert es unter der Herkunft von RAGfind aus. Ohne
  // diesen Umweg blockiert die Cross-Origin-Resource-Policy vieler Seiten die
  // eigenen Dateien, sobald sie in einem fremden Dokument stehen.
  app.get("/view/:documentId/asset", async (request, response, next) => {
    try {
      const resolved = await resolveScopedDocument(request.params.documentId);
      if (!resolved.document) {
        response.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const target = String(request.query.u ?? "").trim();
      if (!target) {
        response.status(400).json({ error: "missing asset url" });
        return;
      }

      const asset = await fetchRemoteAsset(target);
      if (!asset) {
        response.status(404).json({ error: "asset not available" });
        return;
      }

      response.setHeader("Cache-Control", "private, max-age=86400");
      response.setHeader("X-Content-Type-Options", "nosniff");
      // Der Rahmen im Viewer laeuft ohne allow-same-origin und hat damit eine
      // undurchsichtige Herkunft. "same-origin" wuerde ihm die Datei genauso
      // verweigern, wie es die Originalseite tut - der Umweg waere umsonst.
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      response.type(asset.contentType);

      // In einem Stylesheet stehen weitere Adressen - Schriften, Hintergruende,
      // @import. Bleiben die unberuehrt, bricht die Kette beim ersten
      // Weiterverweis genauso ab wie zuvor die erste Datei.
      if (asset.contentType.startsWith("text/css")) {
        response.send(rewriteCssUrls(asset.body.toString("utf8"), target, resolved.document.id));
        return;
      }

      response.send(asset.body);
    } catch (error) {
      next(error);
    }
  });

  // Die PDF-Fassung eines Dokuments: das Original, wenn es eins ist, sonst die
  // von LibreOffice erzeugte Kopie. Der eingebettete Betrachter laedt von hier.
  app.get("/view/:documentId/pdf", async (request, response, next) => {
    try {
      const resolved = await resolveScopedDocument(request.params.documentId);
      if (!resolved.document) {
        response.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const document = resolved.document;
      const file = await getDocumentFile(document.id);
      const sourcePath = absoluteFilePath(file);
      if (!sourcePath) {
        response.status(404).json({ error: "no local original file available" });
        return;
      }

      const pdfPath = await ensurePdfRendition(sourcePath, document.fileType, document.mimeType);
      if (!pdfPath) {
        response.status(404).json({ error: "no pdf rendition available" });
        return;
      }

      response.type("application/pdf");
      response.setHeader("Content-Disposition", "inline");
      response.setHeader("Cache-Control", "private, max-age=3600");
      response.sendFile(pdfPath);
    } catch (error) {
      next(error);
    }
  });

  // Vorschaubild fuer die Trefferliste: bei PDF und Office die erste Seite,
  // bei Bildern das Bild selbst.
  app.get("/view/:documentId/thumb", async (request, response, next) => {
    try {
      const resolved = await resolveScopedDocument(request.params.documentId);
      if (!resolved.document) {
        response.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const document = resolved.document;
      const file = await getDocumentFile(document.id);
      const sourcePath = absoluteFilePath(file);
      if (!sourcePath || !(await fileExists(sourcePath))) {
        response.status(404).json({ error: "no thumbnail available" });
        return;
      }

      const mimeType = (file?.mimeType ?? document.mimeType ?? "").toLowerCase();
      if (mimeType.startsWith("image/")) {
        response.setHeader("Cache-Control", "private, max-age=86400");
        response.type(mimeType);
        response.sendFile(sourcePath);
        return;
      }

      if (!isPdfFile(document.fileType, document.mimeType, sourcePath) && !isOfficeConvertible(document.fileType, document.mimeType)) {
        response.status(404).json({ error: "no thumbnail available" });
        return;
      }

      const pdfPath = await ensurePdfRendition(sourcePath, document.fileType, document.mimeType);
      const thumbnailPath = pdfPath ? await ensurePdfThumbnail(pdfPath) : null;
      if (!thumbnailPath) {
        response.status(404).json({ error: "no thumbnail available" });
        return;
      }

      response.setHeader("Cache-Control", "private, max-age=86400");
      response.type("image/jpeg");
      response.sendFile(thumbnailPath);
    } catch (error) {
      next(error);
    }
  });

  // pdf.js liegt im Paket, nicht im Repo. Statisch ausgeliefert braucht der
  // Betrachter weder Build-Schritt noch kopierte Dateien im Arbeitsbaum.
  app.use("/pdfjs", express.static(PDFJS_ROOT, { maxAge: "7d", immutable: true }));

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
