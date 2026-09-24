import { mkdir } from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import axios from "axios";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { crawlQueue, gitRepoSyncQueue, ingestQueue, reembedQueue, syncQueue } from "../queues";
import { SchedulerService } from "../services/schedulerService";
import { VectorService } from "../services/vectorService";
import { rerankerService } from "../services/rerankerService";
import { buildDocumentEmbeddingInput } from "../services/embeddingInputService";
import { AnalysisService, type AnalysisResponse, type ComparisonResponse, type CrossReferenceResponse, type SummaryResponse } from "../services/analysisService";
import {
  findDocument,
  getDocumentSection,
  getDocumentSections,
  getDocumentStructure,
  inferDocumentType,
  type DocumentRecord,
  type DocumentSection,
  type DocumentStructureNode
} from "../services/documentService";
import {
  buildDocumentDownloadUrl,
  deleteStoredDocumentAssets,
  getDocumentFile,
  getDocumentFilesByDocumentIds,
  resolveDocumentLocalFilePath,
  type DocumentFileRecord
} from "../services/originalFileService";
import { searchIndexService } from "../services/searchIndexService";
import type { SearchChunkCandidate } from "../services/searchIndexService";
import type { SearchDocumentCandidate } from "../services/searchIndexService";
import {
  type AuthenticatedMcpPrincipal,
  createKnowledgeBase,
  createMcpPrincipal,
  deleteKnowledgeBase,
  deleteMcpPrincipal,
  hasEnabledMcpPrincipals,
  listKnowledgeBases,
  listMcpPrincipals,
  resolveMcpPrincipalByToken,
  rotateMcpPrincipalToken,
  updateKnowledgeBase,
  updateMcpPrincipal
} from "../services/adminAccessService";
import { changeAdminPassword } from "../services/adminAuthService";
import { createAdminUser, listAdminUsers } from "../services/adminAuthService";
import { logger } from "../utils/logger";
import { DocumentClassificationService } from "../services/classificationService";
import {
  ensureDocumentTypeSettingsLoaded,
  getDocumentTypeSettingByKey,
  getDocumentTypeSettingsSnapshot,
  getEnabledDocumentTypeSettingsSnapshot,
  updateDocumentTypeSetting,
  type DocumentTypeSearchSettings
} from "../services/documentTypeRegistryService";
import { getRagfindSettings, updateRagfindSettings } from "../services/ragfindSettingsService";
import {
  getAiProviderConnection,
  getAiProviderSettings,
  getEmbeddingModelName,
  updateAiProviderSettings,
  type UpdateAiProviderSettingsInput
} from "../services/aiProviderSettingsService";
import { checkReachable as checkAiProviderReachable, listModels as listAiProviderModels, type AiProvider, type AiProviderConnection } from "../services/aiProviderClient";

interface SimilarityRow {
  chunk_id: number;
  document_id: number;
  title: string | null;
  source_type: string;
  source_ref: string;
  source_url: string | null;
  content: string;
  score: number;
  vector_score: number;
  keyword_score: number;
  document_match_score: number;
  exact_match: boolean;
  metadata: Record<string, unknown>;
}

interface QueryItem {
  chunkId: number;
  documentId: number;
  title: string | null;
  sourceType: string;
  sourceRef: string;
  sourceUrl: string | null;
  content: string;
  score: number;
  vectorScore: number;
  keywordScore: number;
  documentMatchScore: number;
  exactMatch: boolean;
  metadata: Record<string, unknown>;
  documentType?: string;
  originalFile?: DocumentFileRecord | null;
  elasticsearchScore?: number;
  elasticsearchDocumentScore?: number;
  // Raw cross-encoder relevance (0..1) when a reranker was used; `score` holds
  // the value rescaled onto the fusion range.
  rerankScore?: number;
}

export interface QueryResponse {
  query: string;
  model: string;
  topK: number;
  context: string;
  items: QueryItem[];
  sources: OpenWebUiSource[];
  citations: OpenWebUiSource[];
  mode: "similarity" | "inventory";
  answerGuidance: string;
}

interface DocumentContextRow {
  document_id: number;
  title: string | null;
  source_type: string;
  source_ref: string;
  source_url: string | null;
  chunk_id: number;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  document_metadata: Record<string, unknown>;
  keyword_score: number;
}

interface DocumentInventoryRow {
  document_id: number;
  title: string | null;
  source_type: string;
  source_ref: string;
  source_url: string | null;
  file_type: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
  preview: string | null;
}

interface OpenWebUiSource {
  source: {
    id: string;
    name: string;
    type: string;
    url?: string;
  };
  document: string[];
  metadata: Array<Record<string, unknown>>;
  distances: number[];
}

const SEARCH_STOP_TERMS = new Set([
  "was", "waren", "welche", "welcher", "welches", "wer", "wie", "wo", "wann",
  "gibt", "gab", "hat", "haben", "hast", "ist", "sind", "der", "die", "das",
  "den", "dem", "des", "ein", "eine", "einer", "einem", "und", "oder", "aber",
  "am", "an", "im", "in", "zu", "zum", "zur", "vom", "von", "mit", "ueber", "über", "du", "ihr",
  "er", "sie", "es", "muesstest", "musstest", "müsstest", "bitte", "doch", "mal",
  "das", "ganze", "kapitel", "genau", "macht", "machen"
]);

const DEFAULT_DOCUMENT_TYPE_SEARCH_SETTINGS: DocumentTypeSearchSettings = {
  searchProfile: "generic",
  preferContentMatches: false,
  preferDocumentFocus: false,
  requireFocusTerms: false,
  preferAdjacentSections: false,
  adjacentSectionWindow: 1,
  smallToBigWindow: 1
};

interface SearchOptions {
  category?: string;
  documentType?: string;
  sourceTypes?: string[];
  fileTypes?: string[];
  enableRerank?: boolean;
  enableSmallToBig?: boolean;
  allowedKnowledgeBaseIds?: number[];
  preferContentMatches?: boolean;
  preferDocumentFocus?: boolean;
  requireFocusTerms?: boolean;
  preferAdjacentSections?: boolean;
  adjacentSectionWindow?: number;
  smallToBigWindow?: number;
}

export interface DocumentFulltextResponse {
  document: DocumentRecord;
  fulltext: string;
  truncated: boolean;
  totalLength: number;
  originalFile: DocumentFileRecord | null;
}

export interface DocumentSectionsResponse {
  document: DocumentRecord;
  sections: DocumentSection[];
}

export interface DocumentSectionResponse {
  document: DocumentRecord;
  section: DocumentSection;
}

export interface DocumentStructureResponse {
  document: DocumentRecord;
  documentType: string;
  nodes: DocumentStructureNode[];
}

export interface DocumentOriginalResponse {
  document: DocumentRecord;
  originalFile: DocumentFileRecord | null;
}

export interface DocumentComparisonResponse extends ComparisonResponse {}

export interface TopicCrossReferenceResponse extends CrossReferenceResponse {}

const analysisService = new AnalysisService();
const documentClassificationService = new DocumentClassificationService();

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_request, _file, callback) => {
      try {
        await mkdir(env.UPLOAD_DIR, { recursive: true });
        callback(null, env.UPLOAD_DIR);
      } catch (error) {
        callback(error as Error, env.UPLOAD_DIR);
      }
    },
    filename: (_request, file, callback) => {
      const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      callback(null, safeName);
    }
  })
});

async function getCounts() {
  const [documents, chunks, schedules] = await Promise.all([
    pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM documents"),
    pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM document_chunks"),
    pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM scheduled_jobs WHERE enabled = TRUE")
  ]);

  return {
    documents: Number(documents.rows[0].count),
    chunks: Number(chunks.rows[0].count),
    schedules: Number(schedules.rows[0].count)
  };
}

function normalizeFilterList(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function parseKnowledgeBaseId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function extractApiToken(request: express.Request): string | null {
  const authorization = request.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim() || null;
  }

  const apiKey = request.header("x-api-key");
  return apiKey?.trim() || null;
}

function getAllowedKnowledgeBaseIds(response: express.Response): number[] | undefined {
  const principal = response.locals.apiPrincipal as AuthenticatedMcpPrincipal | undefined;
  return principal?.knowledgeBaseIds;
}

function normalizeCategory(category?: string): string | null {
  const normalized = category?.trim().toLowerCase();
  return normalized || null;
}

function getDocumentTypeCategory(documentType?: string): string | null {
  if (!documentType) {
    return null;
  }

  const setting = getDocumentTypeSettingsSnapshot().find((entry) => entry.key === documentType.trim().toLowerCase());
  return setting?.category ?? null;
}

function matchesCategory(item: QueryItem, category?: string): boolean {
  const normalized = normalizeCategory(category);
  if (!normalized) {
    return true;
  }

  const documentType = item.documentType ?? inferDocumentType(item);
  const documentCategory = getDocumentTypeCategory(documentType);
  if (["all", "any"].includes(normalized)) {
    return true;
  }
  if (["local", "internal"].includes(normalized)) {
    return item.sourceType === "upload" || item.sourceType === "directory" || item.sourceType === "sync";
  }
  if (["web", "crawl"].includes(normalized)) {
    return item.sourceType.startsWith("crawl") || documentType === "web";
  }
  if (["protocol", "meeting", "minutes"].includes(normalized)) {
    return documentType === "protocol";
  }
  if (["book", "manual"].includes(normalized)) {
    return documentType === "book" || documentType === "documentation";
  }
  if (["paper", "research"].includes(normalized)) {
    return documentType === "paper";
  }
  if (["policy", "contract"].includes(normalized)) {
    return documentType === "policy" || documentType === "contract";
  }

  return documentType === normalized
    || documentCategory === normalized
    || item.sourceType === normalized
    || (item.metadata.fileType as string | undefined)?.toLowerCase() === normalized;
}

function getDocumentTypeSearchSettings(documentType?: string): DocumentTypeSearchSettings {
  return getDocumentTypeSettingByKey(documentType)?.searchSettings ?? DEFAULT_DOCUMENT_TYPE_SEARCH_SETTINGS;
}

function getItemSearchSettings(item: QueryItem): DocumentTypeSearchSettings {
  return getDocumentTypeSearchSettings(item.documentType ?? inferDocumentType(item));
}

function buildEffectiveSearchOptions(baseOptions: SearchOptions | undefined, dominantItem: QueryItem | null): SearchOptions {
  const searchSettings = dominantItem ? getItemSearchSettings(dominantItem) : DEFAULT_DOCUMENT_TYPE_SEARCH_SETTINGS;

  return {
    ...baseOptions,
    preferContentMatches: baseOptions?.preferContentMatches ?? searchSettings.preferContentMatches,
    preferDocumentFocus: baseOptions?.preferDocumentFocus ?? searchSettings.preferDocumentFocus,
    requireFocusTerms: baseOptions?.requireFocusTerms ?? searchSettings.requireFocusTerms,
    preferAdjacentSections: baseOptions?.preferAdjacentSections ?? searchSettings.preferAdjacentSections,
    adjacentSectionWindow: baseOptions?.adjacentSectionWindow ?? searchSettings.adjacentSectionWindow,
    smallToBigWindow: baseOptions?.smallToBigWindow ?? searchSettings.smallToBigWindow
  };
}

function applySearchFilters(items: QueryItem[], options?: SearchOptions): QueryItem[] {
  if (!options) {
    return items;
  }

  const sourceTypes = new Set(normalizeFilterList(options.sourceTypes));
  const fileTypes = new Set(normalizeFilterList(options.fileTypes));
  const requestedDocumentType = options.documentType?.trim().toLowerCase();

  return items.filter((item) => {
    const documentType = item.documentType ?? inferDocumentType(item);
    item.documentType = documentType;

    if (sourceTypes.size > 0 && !sourceTypes.has(item.sourceType.toLowerCase())) {
      return false;
    }

    const fileType = typeof item.metadata.fileType === "string"
      ? item.metadata.fileType.toLowerCase()
      : typeof item.metadata.file_type === "string"
        ? item.metadata.file_type.toLowerCase()
        : undefined;

    if (fileTypes.size > 0 && (!fileType || !fileTypes.has(fileType))) {
      return false;
    }

    if (requestedDocumentType && documentType !== requestedDocumentType) {
      return false;
    }

    return matchesCategory(item, options.category);
  });
}

function hasExplicitSearchFilters(options?: SearchOptions): boolean {
  if (!options) {
    return false;
  }

  return Boolean(
    options.category
    || options.documentType
    || (options.sourceTypes && options.sourceTypes.length > 0)
    || (options.fileTypes && options.fileTypes.length > 0)
  );
}

function calculateRerankScore(item: QueryItem, query: string, options?: SearchOptions): number {
  const queryTerms = normalizeQueryTerms(query).filter((term) => term.length >= 2);
  const significantQueryTerms = queryTerms.filter((term) => term.length >= 4 && !SEARCH_STOP_TERMS.has(term));
  const title = (item.title ?? "").toLowerCase();
  const sourceRef = item.sourceRef.toLowerCase();
  const content = item.content.toLowerCase();
  const sectionTitle = typeof item.metadata.sectionTitle === "string" ? item.metadata.sectionTitle.toLowerCase() : "";
  const queryNormalized = query.toLowerCase();
  const preferContentMatches = options?.preferContentMatches === true;
  const isSoftwareDescriptionQuestion = /\b(software|app|anwendung|projekt|tool|werkzeug|macht|tut|ist)\b/i.test(query);
  const isRepositoryOverviewDoc = /(^|\/|:)(readme|readme\.md|readme\.rst|docs?|about|overview)(\b|$)/i.test(sourceRef) || /^(readme|about|overview)$/i.test(title);
  const isBoilerplateRepoDoc = /(^|\/|:)(license|copying|contributing|changelog|launch\.json|tasks\.json)(\b|$)/i.test(sourceRef) || /^(license|contributing\.md|changelog\.md|launch\.json|tasks\.json)$/i.test(title);
  let score = item.score;

  const contentTermMatches = significantQueryTerms.filter((term) => content.includes(term));
  const titleTermMatches = significantQueryTerms.filter((term) => title.includes(term));
  const sourceRefTermMatches = significantQueryTerms.filter((term) => sourceRef.includes(term));
  const sectionTitleTermMatches = significantQueryTerms.filter((term) => sectionTitle.includes(term));

  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += preferContentMatches ? 0.12 : 0.75;
    }
    if (sourceRef.includes(term)) {
      score += preferContentMatches ? 0.15 : 0.85;
    }
    if (content.includes(term)) {
      score += preferContentMatches ? 0.4 : 0.18;
    }
    if (sectionTitle.includes(term)) {
      score += preferContentMatches ? 0.85 : 0.6;
    }
  }

  if (contentTermMatches.length > 0) {
    score += contentTermMatches.length * (preferContentMatches ? 0.95 : 0.28);
    score += (contentTermMatches.length / Math.max(significantQueryTerms.length, 1)) * (preferContentMatches ? 2.2 : 0.7);
  }

  if (sectionTitleTermMatches.length > 0) {
    score += sectionTitleTermMatches.length * (preferContentMatches ? 0.6 : 0.25);
  }

  if (!preferContentMatches) {
    if (titleTermMatches.length > 0) {
      score += titleTermMatches.length * 0.1;
    }
    if (sourceRefTermMatches.length > 0) {
      score += sourceRefTermMatches.length * 0.12;
    }
  }

  if (queryNormalized && (title.includes(queryNormalized) || sourceRef.includes(queryNormalized))) {
    score += preferContentMatches ? 0.25 : 1.3;
  }
  if (queryNormalized && content.includes(queryNormalized)) {
    score += preferContentMatches ? 1.8 : 1.1;
  }
  if (sectionTitle.includes(queryNormalized)) {
    score += preferContentMatches ? 1.4 : 0.95;
  }
  if (item.documentType && options?.documentType && item.documentType === options.documentType.toLowerCase()) {
    score += 0.9;
  }
  if (matchesCategory(item, options?.category)) {
    score += 0.2;
  }

  if (isSoftwareDescriptionQuestion && item.sourceType === "git") {
    if (isRepositoryOverviewDoc) {
      score += 0.9;
    }
    if (isBoilerplateRepoDoc) {
      score -= 0.8;
    }
  }

  return score;
}

function rerankItems(items: QueryItem[], query: string, options?: SearchOptions): QueryItem[] {
  const rerankLimit = Math.min(Math.max(env.QUERY_RERANK_TOP_N, 1), Math.max(items.length, 1));
  const headItems = items.slice(0, rerankLimit);
  const documentCounts = new Map<number, number>();

  for (const item of headItems) {
    documentCounts.set(item.documentId, (documentCounts.get(item.documentId) ?? 0) + 1);
  }

  const dominantDocumentEntry = [...documentCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  const preferContentMatches = typeof options?.preferContentMatches === "boolean"
    ? options.preferContentMatches
    : Boolean(
        dominantDocumentEntry
        && dominantDocumentEntry[1] >= Math.min(3, rerankLimit)
        && dominantDocumentEntry[1] / Math.max(headItems.length, 1) >= 0.6
      );
  const rerankedHead = items
    .slice(0, rerankLimit)
    .map((item) => ({
      ...item,
      score: calculateRerankScore(item, query, {
        ...options,
        preferContentMatches
      })
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.documentMatchScore - left.documentMatchScore;
    });

  return [...rerankedHead, ...items.slice(rerankLimit)];
}

// Text handed to the cross-encoder. Same context header as the embedding input
// (document title + section heading), because a bare table row or numbered
// clause is just as ambiguous to a reranker as it is to an embedding model.
function buildRerankDocument(item: QueryItem): string {
  const sectionTitle = typeof item.metadata.sectionTitle === "string" ? item.metadata.sectionTitle : null;
  // Length is capped inside RerankerService against RERANKER_DOCUMENT_MAX_CHARS,
  // which also handles a server that rejects the pair anyway.
  return buildDocumentEmbeddingInput({
    documentTitle: item.title ?? item.sourceRef,
    sectionTitle,
    content: item.content
  });
}

// Replaces the lexical heuristic with a cross-encoder when one is configured,
// and falls back to `rerankItems` whenever it is not available - the reranker
// sits in the live query path, so its absence must cost ranking quality, never
// results.
//
// The relevance scores (0..1) are mapped onto the score range the head already
// had rather than used raw: downstream stages (`applyAdjacentSectionBias`) add
// and subtract absolute bonuses tuned for the fusion scale, and a raw 0..1
// score would let those bonuses override the cross-encoder entirely. The span
// has a floor so a head with near-identical fusion scores still gets a usable
// spread.
const MIN_RERANK_SCORE_SPAN = 2;

export async function rerankItemsWithCrossEncoder(
  items: QueryItem[],
  query: string,
  options?: SearchOptions
): Promise<{ items: QueryItem[]; usedCrossEncoder: boolean }> {
  if (items.length === 0 || !(await rerankerService.isConfigured())) {
    return { items: rerankItems(items, query, options), usedCrossEncoder: false };
  }

  const topN = Math.min(await rerankerService.getTopN(), items.length);
  const head = items.slice(0, topN);
  const tail = items.slice(topN);

  const results = await rerankerService.rerank(query, head.map(buildRerankDocument), topN);
  if (!results || results.length === 0) {
    return { items: rerankItems(items, query, options), usedCrossEncoder: false };
  }

  const headScores = head.map((item) => item.score);
  const maxScore = Math.max(...headScores);
  const minScore = Math.min(...headScores);
  const span = Math.max(maxScore - minScore, MIN_RERANK_SCORE_SPAN);

  const rerankedHead: QueryItem[] = [];
  const placed = new Set<number>();
  for (const result of results) {
    const item = head[result.index];
    if (!item) {
      continue;
    }

    placed.add(result.index);
    rerankedHead.push({
      ...item,
      score: minScore + (result.score * span),
      rerankScore: result.score
    });
  }

  // A server that honours `top_n` returns fewer rows than it was given; the
  // candidates it dropped keep their fusion order below the ranked ones.
  const unplaced = head.filter((_, index) => !placed.has(index));

  return { items: [...rerankedHead, ...unplaced, ...tail], usedCrossEncoder: true };
}

function mergeElasticsearchSignals(
  items: QueryItem[],
  chunkCandidates: SearchChunkCandidate[] | null,
  documentCandidates: SearchDocumentCandidate[] | null
): QueryItem[] {
  if ((!chunkCandidates || chunkCandidates.length === 0) && (!documentCandidates || documentCandidates.length === 0)) {
    return items;
  }

  const highestChunkScore = Math.max(...(chunkCandidates ?? []).map((candidate) => candidate.score), 0);
  const chunkCandidateCount = chunkCandidates?.length ?? 0;
  const chunkCandidateMap = new Map<number, SearchChunkCandidate>(
    (chunkCandidates ?? []).map((candidate) => [candidate.chunkId, candidate])
  );
  const highestDocumentScore = Math.max(...(documentCandidates ?? []).map((candidate) => candidate.score), 0);
  const documentCandidateCount = documentCandidates?.length ?? 0;
  const documentCandidateMap = new Map<number, SearchDocumentCandidate>(
    (documentCandidates ?? []).map((candidate) => [candidate.documentId, candidate])
  );

  return items
    .map((item) => {
      const chunkCandidate = chunkCandidateMap.get(item.chunkId);
      const documentCandidate = documentCandidateMap.get(item.documentId);
      const normalizedChunkScore = chunkCandidate && highestChunkScore > 0 ? chunkCandidate.score / highestChunkScore : 0;
      const chunkRankBoost = chunkCandidate && chunkCandidateCount > 0 ? 1 - ((chunkCandidate.rank - 1) / chunkCandidateCount) : 0;
      const elasticsearchScore = chunkCandidate
        ? Math.max(0, (normalizedChunkScore * 0.65) + (chunkRankBoost * 0.35))
        : 0;
      const normalizedDocumentScore = documentCandidate && highestDocumentScore > 0 ? documentCandidate.score / highestDocumentScore : 0;
      const documentRankBoost = documentCandidate && documentCandidateCount > 0 ? 1 - ((documentCandidate.rank - 1) / documentCandidateCount) : 0;
      const elasticsearchDocumentScore = documentCandidate
        ? Math.max(0, (normalizedDocumentScore * 0.6) + (documentRankBoost * 0.4))
        : 0;
      const combinedBoost = (elasticsearchScore * 1.1) + (elasticsearchDocumentScore * 0.85);

      return {
        ...item,
        score: item.score + combinedBoost,
        keywordScore: item.keywordScore + (elasticsearchScore * 0.75) + (elasticsearchDocumentScore * 0.35),
        elasticsearchScore,
        elasticsearchDocumentScore,
        metadata: {
          ...item.metadata,
          elasticsearchScore,
          elasticsearchRank: chunkCandidate?.rank,
          elasticsearchRawScore: chunkCandidate?.score,
          elasticsearchDocumentScore,
          elasticsearchDocumentRank: documentCandidate?.rank,
          elasticsearchDocumentRawScore: documentCandidate?.score
        }
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.documentMatchScore !== left.documentMatchScore) {
        return right.documentMatchScore - left.documentMatchScore;
      }
      if (right.keywordScore !== left.keywordScore) {
        return right.keywordScore - left.keywordScore;
      }
      return right.vectorScore - left.vectorScore;
    });
}

async function expandItemContext(item: QueryItem): Promise<QueryItem> {
  const chunkResult = await pool.query<{
    document_id: number;
    chunk_index: number;
    document_section_id: number | null;
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT document_id, chunk_index, document_section_id, metadata
      FROM document_chunks
      WHERE id = $1
      LIMIT 1
    `,
    [item.chunkId]
  );

  if (chunkResult.rowCount === 0) {
    return item;
  }

  const chunk = chunkResult.rows[0];
  if (chunk.document_section_id) {
    const sectionResult = await pool.query<{
      section_index: number;
      title: string;
      content: string;
      section_type: string;
      page_start: number | null;
      page_end: number | null;
    }>(
      `
        SELECT section_index, title, content, section_type, page_start, page_end
        FROM document_sections
        WHERE id = $1
        LIMIT 1
      `,
      [chunk.document_section_id]
    );

    if ((sectionResult.rowCount ?? 0) > 0) {
      const section = sectionResult.rows[0];
      return {
        ...item,
        content: section.content,
        metadata: {
          ...item.metadata,
          expandedContext: "section",
          sectionIndex: section.section_index,
          sectionTitle: section.title,
          sectionType: section.section_type,
          pageStart: section.page_start,
          pageEnd: section.page_end
        }
      };
    }
  }

  const windowSize = Math.max(0, env.QUERY_SMALL_TO_BIG_WINDOW);
  const neighborResult = await pool.query<{ content: string; chunk_index: number }>(
    `
      SELECT content, chunk_index
      FROM document_chunks
      WHERE document_id = $1
        AND chunk_index BETWEEN $2 AND $3
      ORDER BY chunk_index ASC
    `,
    [chunk.document_id, Math.max(0, chunk.chunk_index - windowSize), chunk.chunk_index + windowSize]
  );

  if (neighborResult.rowCount === 0) {
    return item;
  }

  return {
    ...item,
    content: neighborResult.rows.map((row) => row.content).join("\n\n---\n\n"),
    metadata: {
      ...item.metadata,
      expandedContext: "chunk_window",
      chunkIndex: chunk.chunk_index,
      window: windowSize
    }
  };
}

async function applySmallToBig(items: QueryItem[], topK: number): Promise<QueryItem[]> {
  const expanded = await Promise.all(items.slice(0, topK).map((item) => expandItemContext(item)));
  const seen = new Set<string>();

  return expanded.filter((item) => {
    const contextKey = typeof item.metadata.sectionIndex === "number"
      ? `section:${item.documentId}:${item.metadata.sectionIndex}`
      : `chunk:${item.documentId}:${item.chunkId}`;
    if (seen.has(contextKey)) {
      return false;
    }
    seen.add(contextKey);
    return true;
  });
}

async function expandItemContextWithWindow(item: QueryItem, windowOverride?: number): Promise<QueryItem> {
  if (typeof windowOverride !== "number") {
    return expandItemContext(item);
  }

  const chunkResult = await pool.query<{
    document_id: number;
    chunk_index: number;
    document_section_id: number | null;
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT document_id, chunk_index, document_section_id, metadata
      FROM document_chunks
      WHERE id = $1
      LIMIT 1
    `,
    [item.chunkId]
  );

  if (chunkResult.rowCount === 0) {
    return item;
  }

  const chunk = chunkResult.rows[0];
  if (chunk.document_section_id) {
    return expandItemContext(item);
  }

  const windowSize = Math.max(0, Math.floor(windowOverride));
  const neighborResult = await pool.query<{ content: string; chunk_index: number }>(
    `
      SELECT content, chunk_index
      FROM document_chunks
      WHERE document_id = $1
        AND chunk_index BETWEEN $2 AND $3
      ORDER BY chunk_index ASC
    `,
    [chunk.document_id, Math.max(0, chunk.chunk_index - windowSize), chunk.chunk_index + windowSize]
  );

  if (neighborResult.rowCount === 0) {
    return item;
  }

  return {
    ...item,
    content: neighborResult.rows.map((row) => row.content).join("\n\n---\n\n"),
    metadata: {
      ...item.metadata,
      expandedContext: "chunk_window",
      chunkIndex: chunk.chunk_index,
      window: windowSize
    }
  };
}

async function applySmallToBigWithWindow(items: QueryItem[], topK: number, windowOverride?: number): Promise<QueryItem[]> {
  const expanded = await Promise.all(items.slice(0, topK).map((item) => expandItemContextWithWindow(item, windowOverride)));
  const seen = new Set<string>();

  return expanded.filter((item) => {
    const contextKey = typeof item.metadata.sectionIndex === "number"
      ? `section:${item.documentId}:${item.metadata.sectionIndex}`
      : `chunk:${item.documentId}:${item.chunkId}`;
    if (seen.has(contextKey)) {
      return false;
    }
    seen.add(contextKey);
    return true;
  });
}

function getItemPosition(item: QueryItem): number | null {
  if (typeof item.metadata.sectionIndex === "number" && Number.isFinite(item.metadata.sectionIndex)) {
    return item.metadata.sectionIndex;
  }
  if (typeof item.metadata.pageStart === "number" && Number.isFinite(item.metadata.pageStart)) {
    return item.metadata.pageStart;
  }
  if (typeof item.metadata.chunkIndex === "number" && Number.isFinite(item.metadata.chunkIndex)) {
    return item.metadata.chunkIndex;
  }
  return null;
}

function applyAdjacentSectionBias(items: QueryItem[], dominantDocumentId: number, adjacentWindow: number): QueryItem[] {
  const documentItems = items.filter((item) => item.documentId === dominantDocumentId);
  const anchor = documentItems
    .map((item) => {
      const position = getItemPosition(item);
      if (position === null) {
        return null;
      }

      const neighborhoodWeight = documentItems.reduce((sum, candidate) => {
        const candidatePosition = getItemPosition(candidate);
        if (candidatePosition === null) {
          return sum;
        }

        const distance = Math.abs(candidatePosition - position);
        if (distance > Math.max(adjacentWindow + 2, 3)) {
          return sum;
        }

        return sum + Math.max(0.2, 1.6 - (distance * 0.35));
      }, 0);

      return {
        item,
        position,
        neighborhoodWeight
      };
    })
    .filter((entry): entry is { item: QueryItem; position: number; neighborhoodWeight: number } => entry !== null)
    .sort((left, right) => {
      if (right.neighborhoodWeight !== left.neighborhoodWeight) {
        return right.neighborhoodWeight - left.neighborhoodWeight;
      }
      if (right.item.score !== left.item.score) {
        return right.item.score - left.item.score;
      }
      return left.position - right.position;
    })[0]?.item;
  const anchorPosition = anchor ? getItemPosition(anchor) : null;
  if (anchorPosition === null) {
    return items;
  }

  const primaryWindow = Math.max(0, adjacentWindow);
  const extendedWindow = Math.max(primaryWindow + 2, 3);

  return [...items]
    .map((item) => {
      if (item.documentId !== dominantDocumentId) {
        return item;
      }

      const itemPosition = getItemPosition(item);
      if (itemPosition === null) {
        return item;
      }

      const distance = Math.abs(itemPosition - anchorPosition);
      let adjustedScore = item.score;

      if (distance <= primaryWindow) {
        adjustedScore += 3 - (distance * 0.7);
      } else if (distance <= extendedWindow) {
        adjustedScore += Math.max(0.15, 1.2 - ((distance - primaryWindow) * 0.35));
      } else {
        adjustedScore -= Math.min(8, (distance - extendedWindow + 1) * 0.3);
      }

      return {
        ...item,
        score: adjustedScore
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.documentMatchScore !== left.documentMatchScore) {
        return right.documentMatchScore - left.documentMatchScore;
      }
      if (right.keywordScore !== left.keywordScore) {
        return right.keywordScore - left.keywordScore;
      }
      return right.vectorScore - left.vectorScore;
    });
}

async function attachOriginalFiles(items: QueryItem[]): Promise<QueryItem[]> {
  const fileMap = await getDocumentFilesByDocumentIds([...new Set(items.map((item) => item.documentId))]);
  return items.map((item) => ({
    ...item,
    originalFile: fileMap.get(item.documentId) ?? null,
    metadata: {
      ...item.metadata,
      documentType: item.documentType ?? inferDocumentType(item),
      ...(fileMap.get(item.documentId)
        ? {
            originalDownloadUrl: fileMap.get(item.documentId)?.downloadUrl,
            originalName: fileMap.get(item.documentId)?.originalName,
            originalLocalAvailable: fileMap.get(item.documentId)?.localAvailable
          }
        : {})
    }
  }));
}

function getDominantDocumentId(items: QueryItem[], sampleSize = 5): number | null {
  const headItems = items.slice(0, sampleSize);
  if (headItems.length === 0) {
    return null;
  }

  const documentCounts = new Map<number, number>();
  const documentScoreTotals = new Map<number, number>();
  for (const item of headItems) {
    documentCounts.set(item.documentId, (documentCounts.get(item.documentId) ?? 0) + 1);
    documentScoreTotals.set(item.documentId, (documentScoreTotals.get(item.documentId) ?? 0) + Math.max(item.score, 0));
  }

  const dominantDocumentEntry = [...documentCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!dominantDocumentEntry) {
    return null;
  }

  const totalScore = [...documentScoreTotals.values()].reduce((sum, value) => sum + value, 0);
  const dominantScore = documentScoreTotals.get(dominantDocumentEntry[0]) ?? 0;
  const scoreShare = totalScore > 0 ? dominantScore / totalScore : 0;

  return dominantDocumentEntry[1] >= Math.min(3, headItems.length)
    && (dominantDocumentEntry[1] / headItems.length >= 0.5 || scoreShare >= 0.45)
    ? dominantDocumentEntry[0]
    : null;
}

function buildDocumentFocusQuery(query: string, referenceText: string): string {
  const normalizedReference = referenceText.toLowerCase();
  const focusTerms = normalizeQueryTerms(query)
    .filter((term) => term.length >= 4 && !SEARCH_STOP_TERMS.has(term))
    .filter((term) => !normalizedReference.includes(term));

  return focusTerms.length > 0 ? focusTerms.join(" ") : query;
}

function filterItemsByFocusTerms(items: QueryItem[], focusQuery: string): QueryItem[] {
  const focusTerms = normalizeQueryTerms(focusQuery)
    .filter((term) => term.length >= 4 && !SEARCH_STOP_TERMS.has(term));

  if (focusTerms.length === 0) {
    return items;
  }

  const filteredItems = items.filter((item) => {
    const tokens = new Set(
      normalizeQueryTerms(`${item.content} ${(item.metadata.sectionTitle as string | undefined) ?? ""}`)
    );

    return focusTerms.some((term) => [...tokens].some((token) => token === term || token.startsWith(term) || term.startsWith(token)));
  });

  return filteredItems.length > 0 ? filteredItems : items;
}

async function refineNarrativeSectionsWithinDocument(documentId: number, focusQuery: string, limit: number): Promise<QueryItem[]> {
  const result = await pool.query<{
    chunk_id: number | null;
    document_id: number;
    title: string | null;
    source_type: string;
    source_ref: string;
    source_url: string | null;
    content: string;
    metadata: Record<string, unknown> | null;
    section_index: number;
    section_title: string;
    section_type: string;
    page_start: number | null;
    page_end: number | null;
    term_hits: number;
  }>(
    `
      WITH query_terms AS (
        SELECT DISTINCT term
        FROM regexp_split_to_table(lower(regexp_replace($2::text, '[^[:alnum:]]+', ' ', 'g')), '\\s+') AS term
        WHERE char_length(term) >= 4
          AND term NOT IN (
            'was', 'waren', 'welche', 'welcher', 'welches', 'wer', 'wie', 'wo', 'wann',
            'gibt', 'gab', 'hat', 'haben', 'hast', 'ist', 'sind', 'der', 'die', 'das',
            'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'und', 'oder', 'aber',
            'am', 'an', 'im', 'in', 'zu', 'zum', 'zur', 'vom', 'von', 'mit', 'ueber', 'uber', 'du', 'ihr',
            'er', 'sie', 'es', 'muesstest', 'musstest', 'bitte', 'doch', 'mal', 'ganze', 'kapitel'
          )
      ),
      matched_sections AS (
        SELECT
          s.id AS section_id,
          d.id AS document_id,
          d.title,
          d.source_type,
          d.source_ref,
          d.source_url,
          d.metadata,
          s.section_index,
          s.title AS section_title,
          s.content,
          s.section_type,
          s.page_start,
          s.page_end,
          COUNT(*) FILTER (
            WHERE (' ' || s.search_content_normalized || ' ') LIKE '% ' || term || '%'
              OR (' ' || s.search_title_normalized || ' ') LIKE '% ' || term || '%'
          ) AS term_hits
        FROM document_sections s
        INNER JOIN documents d ON d.id = s.document_id
        CROSS JOIN query_terms
        WHERE s.document_id = $1
        GROUP BY s.id, d.id, d.title, d.source_type, d.source_ref, d.source_url, d.metadata,
                 s.section_index, s.title, s.content, s.section_type, s.page_start, s.page_end
      )
      SELECT
        c.id AS chunk_id,
        ms.document_id,
        ms.title,
        ms.source_type,
        ms.source_ref,
        ms.source_url,
        ms.content,
        ms.metadata,
        ms.section_index,
        ms.section_title,
        ms.section_type,
        ms.page_start,
        ms.page_end,
        ms.term_hits
      FROM matched_sections ms
      LEFT JOIN LATERAL (
        SELECT id
        FROM document_chunks
        WHERE document_section_id = ms.section_id
        ORDER BY chunk_index ASC, id ASC
        LIMIT 1
      ) c ON TRUE
      WHERE ms.term_hits > 0
      ORDER BY ms.term_hits DESC, ms.section_index ASC
      LIMIT $3::integer
    `,
    [documentId, focusQuery, Math.max(limit, 1)]
  );

  return result.rows.map((row) => ({
    chunkId: Number(row.chunk_id ?? 0),
    documentId: Number(row.document_id),
    title: row.title,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    sourceUrl: row.source_url,
    content: row.content,
    score: Number(row.term_hits) * 4,
    vectorScore: 0,
    keywordScore: Number(row.term_hits),
    documentMatchScore: Number(row.term_hits),
    exactMatch: Number(row.term_hits) > 1,
    metadata: {
      ...(row.metadata ?? {}),
      expandedContext: "section",
      sectionIndex: row.section_index,
      sectionTitle: row.section_title,
      sectionType: row.section_type,
      pageStart: row.page_start,
      pageEnd: row.page_end
    },
    documentType: inferDocumentType({
      title: row.title,
      sourceRef: row.source_ref,
      sourceType: row.source_type,
      metadata: row.metadata ?? undefined
    })
  }));
}

async function refineItemsWithinDocument(documentId: number, query: string, limit: number): Promise<QueryItem[]> {
  const documentResult = await pool.query<{ title: string | null; source_ref: string }>(
    `
      SELECT title, source_ref
      FROM documents
      WHERE id = $1
      LIMIT 1
    `,
    [documentId]
  );

  const document = documentResult.rows[0];
  const focusQuery = document
    ? buildDocumentFocusQuery(query, `${document.title ?? ""} ${document.source_ref}`)
    : query;
  const result = await pool.query<SimilarityRow>(
    `
      WITH query_input AS (
        SELECT
          NULLIF(BTRIM($2), '') AS raw_query,
          NULLIF(BTRIM(lower(regexp_replace($2, '[^[:alnum:]]+', ' ', 'g'))), '') AS normalized_query
      ),
      query_terms AS (
        SELECT DISTINCT term
        FROM query_input q,
        LATERAL regexp_split_to_table(COALESCE(q.normalized_query, ''), '\\s+') AS term
        WHERE char_length(term) >= 4
          AND term NOT IN (
            'was', 'waren', 'welche', 'welcher', 'welches', 'wer', 'wie', 'wo', 'wann',
            'gibt', 'gab', 'hat', 'haben', 'hast', 'ist', 'sind', 'der', 'die', 'das',
            'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'und', 'oder', 'aber',
            'am', 'an', 'im', 'in', 'zu', 'zum', 'zur', 'vom', 'von', 'mit', 'du', 'ihr',
            'er', 'sie', 'es', 'muesstest', 'musstest', 'müsstest', 'bitte', 'doch', 'mal',
            'ganze', 'kapitel'
          )
      ),
      query_search AS (
        SELECT
          tsquery,
          tsquery_de,
          (tsquery IS NOT NULL AND numnode(tsquery) > 0) AS has_tsquery,
          (tsquery_de IS NOT NULL AND numnode(tsquery_de) > 0) AS has_tsquery_de
        FROM (
          SELECT
            CASE
              WHEN EXISTS (SELECT 1 FROM query_terms)
                THEN to_tsquery('simple', (SELECT string_agg(term, ' | ') FROM query_terms))
              ELSE NULL
            END AS tsquery,
            -- German stemming and stop words, so "Dienstplaene" matches "Dienstplan".
            -- Added NEXT TO the 'simple' query rather than replacing it: only 'simple'
            -- still matches file names, Aktenzeichen and identifiers verbatim, and the
            -- German stemmer would mangle exactly those. Every site below takes the
            -- better of the two ranks (see migrations/021_german_text_search.sql).
            CASE
              WHEN EXISTS (SELECT 1 FROM query_terms)
                THEN to_tsquery('german', (SELECT string_agg(term, ' | ') FROM query_terms))
              ELSE NULL
            END AS tsquery_de
        ) built_queries
      ),
      ranked AS (
        SELECT
          c.id AS chunk_id,
          d.id AS document_id,
          d.title,
          d.source_type,
          d.source_ref,
          d.source_url,
          c.content,
          d.metadata,
          (
            (COALESCE(local_hits.term_hits, 0) * 1.1)
            + (COALESCE(local_hits.section_hits, 0) * 0.9)
            + COALESCE(local_hits.keyword_score, 0)
            + (CASE WHEN local_hits.phrase_match THEN 2.5 ELSE 0 END)
          ) AS score,
          0::double precision AS vector_score,
          COALESCE(local_hits.keyword_score, 0) AS keyword_score,
          COALESCE(local_hits.term_hits, 0) + COALESCE(local_hits.section_hits, 0) AS document_match_score,
          local_hits.phrase_match AS exact_match,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(c.document_section_id, -c.id)
            ORDER BY
              (CASE WHEN local_hits.phrase_match THEN 1 ELSE 0 END) DESC,
              (COALESCE(local_hits.term_hits, 0) + COALESCE(local_hits.section_hits, 0)) DESC,
              COALESCE(local_hits.keyword_score, 0) DESC,
              c.chunk_index ASC,
              c.id ASC
          ) AS section_rank
        FROM document_chunks c
        INNER JOIN documents d ON d.id = c.document_id
        LEFT JOIN document_sections s ON s.id = c.document_section_id
        CROSS JOIN query_input qi
        CROSS JOIN query_search qs
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE strpos(c.search_content_normalized, term) > 0) AS term_hits,
            COUNT(*) FILTER (
              WHERE strpos(COALESCE(s.search_content_normalized, ''), term) > 0
                OR strpos(COALESCE(s.search_title_normalized, ''), term) > 0
            ) AS section_hits,
            GREATEST(
              CASE
                WHEN qs.has_tsquery THEN COALESCE(ts_rank_cd(
                  COALESCE(s.search_tsv, setweight(c.search_content_tsv, 'B')),
                  qs.tsquery
                ), 0)
                ELSE 0
              END,
              CASE
                WHEN qs.has_tsquery_de THEN COALESCE(ts_rank_cd(
                  COALESCE(s.search_tsv_de, setweight(c.search_content_tsv_de, 'B')),
                  qs.tsquery_de
                ), 0)
                ELSE 0
              END
            ) AS keyword_score,
            CASE
              WHEN qi.normalized_query IS NOT NULL AND qi.normalized_query <> '' AND (
                strpos(c.search_content_normalized, qi.normalized_query) > 0
                OR strpos(COALESCE(s.search_content_normalized, ''), qi.normalized_query) > 0
                OR strpos(COALESCE(s.search_title_normalized, ''), qi.normalized_query) > 0
              ) THEN TRUE
              ELSE FALSE
            END AS phrase_match
          FROM query_terms
        ) AS local_hits ON TRUE
        WHERE c.document_id = $1
      )
      SELECT
        chunk_id,
        document_id,
        title,
        source_type,
        source_ref,
        source_url,
        content,
        score,
        vector_score,
        keyword_score,
        document_match_score,
        exact_match,
        metadata
      FROM ranked
      WHERE section_rank = 1
        AND score > 0
      ORDER BY score DESC, keyword_score DESC, chunk_id
      LIMIT $3::integer
    `,
    [documentId, focusQuery, Math.max(limit, 1)]
  );

  return result.rows.map((row) => ({
    chunkId: Number(row.chunk_id),
    documentId: Number(row.document_id),
    title: row.title,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    sourceUrl: row.source_url,
    content: row.content,
    score: Number(row.score),
    vectorScore: Number(row.vector_score),
    keywordScore: Number(row.keyword_score),
    documentMatchScore: Number(row.document_match_score),
    exactMatch: row.exact_match,
    metadata: row.metadata,
    documentType: inferDocumentType({
      title: row.title,
      sourceRef: row.source_ref,
      sourceType: row.source_type,
      metadata: row.metadata
    })
  }));
}

export async function executeSimilarityQuery(
  query: string,
  topK: number,
  model: string,
  vectorService: VectorService,
  searchOptions?: SearchOptions
): Promise<QueryResponse> {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const candidateK = Math.max(topK * 4, env.QUERY_CANDIDATE_K, 24);
  const candidateStageStartedAt = Date.now();
  const [embedding, elasticChunkCandidates, elasticDocumentCandidates] = await Promise.all([
    // Query side gets the model's query prefix; the document side is prefixed
    // when the chunk is embedded (see embeddingInputService).
    vectorService.embedQuery(query, model),
    searchIndexService.searchChunkCandidates(
      query,
      Math.max(candidateK * 3, 50),
      searchOptions?.allowedKnowledgeBaseIds
    ),
    searchIndexService.searchDocumentCandidates(
      query,
      Math.max(topK * 3, 20),
      searchOptions?.allowedKnowledgeBaseIds
    )
  ]);
  timings.embeddingAndCandidatesMs = Date.now() - candidateStageStartedAt;
  const elasticChunkCandidateIds = elasticChunkCandidates?.map((candidate) => candidate.chunkId) ?? null;
  const elasticDocumentCandidateIds = elasticDocumentCandidates?.map((candidate) => candidate.documentId) ?? null;
  const sqlStageStartedAt = Date.now();
  const result = await pool.query<SimilarityRow>(
    `
      WITH query_input AS (
        SELECT
          $1::vector AS embedding,
          NULLIF(BTRIM($2), '') AS raw_query,
          NULLIF(BTRIM(lower(regexp_replace($2, '[^[:alnum:]]+', ' ', 'g'))), '') AS normalized_query
      ),
      query_terms AS (
        SELECT DISTINCT term
        FROM query_input q,
        LATERAL regexp_split_to_table(COALESCE(q.normalized_query, ''), '\\s+') AS term
        WHERE char_length(term) >= 2
          AND term NOT IN (
            'was', 'waren', 'welche', 'welcher', 'welches', 'wer', 'wie', 'wo', 'wann',
            'gibt', 'gab', 'hat', 'haben', 'hast', 'ist', 'sind', 'der', 'die', 'das',
            'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'und', 'oder', 'aber',
            'am', 'an', 'im', 'in', 'zu', 'zum', 'zur', 'vom', 'von', 'mit', 'du', 'ihr',
            'er', 'sie', 'es', 'muesstest', 'musstest', 'müsstest', 'bitte', 'doch', 'mal',
            'dokument', 'dokumente', 'dokumenten', 'unterlage', 'unterlagen', 'datei', 'dateien',
            'genau', 'macht', 'machen'
          )
      ),
      query_search AS (
        SELECT
          tsquery,
          tsquery_de,
          (tsquery IS NOT NULL AND numnode(tsquery) > 0) AS has_tsquery,
          (tsquery_de IS NOT NULL AND numnode(tsquery_de) > 0) AS has_tsquery_de
        FROM (
          SELECT
            CASE
              WHEN EXISTS (SELECT 1 FROM query_terms)
                THEN to_tsquery('simple', (SELECT string_agg(term, ' | ') FROM query_terms))
              ELSE NULL
            END AS tsquery,
            -- German stemming and stop words, so "Dienstplaene" matches "Dienstplan".
            -- Added NEXT TO the 'simple' query rather than replacing it: only 'simple'
            -- still matches file names, Aktenzeichen and identifiers verbatim, and the
            -- German stemmer would mangle exactly those. Every site below takes the
            -- better of the two ranks (see migrations/021_german_text_search.sql).
            CASE
              WHEN EXISTS (SELECT 1 FROM query_terms)
                THEN to_tsquery('german', (SELECT string_agg(term, ' | ') FROM query_terms))
              ELSE NULL
            END AS tsquery_de
        ) built_queries
      ),
      candidate_documents AS (
        SELECT DISTINCT document_id
        FROM (
          SELECT unnest(COALESCE($10::bigint[], ARRAY[]::bigint[])) AS document_id
          UNION ALL
          SELECT c.document_id
          FROM document_chunks c
          WHERE c.id = ANY(COALESCE($11::bigint[], ARRAY[]::bigint[]))
        ) candidate_rows
      ),
      -- Single ACL boundary for the whole query: every candidate source below
      -- joins this, so a document outside the permitted knowledge bases cannot
      -- reach the result. It used to be enforced indirectly through the
      -- document_signals join, which stopped being possible once signals moved
      -- behind candidate selection.
      scoped_documents AS (
        SELECT d.id AS document_id
        FROM documents d
        WHERE (
          $9::bigint[] IS NULL
          OR (cardinality($9::bigint[]) > 0 AND d.knowledge_base_id = ANY($9::bigint[]))
        )
          AND (
            NOT EXISTS (SELECT 1 FROM candidate_documents)
            OR d.id IN (SELECT document_id FROM candidate_documents)
          )
      ),
      -- Two things keep this on the HNSW index instead of a full scan over every
      -- chunk:
      --   * the query vector is written as $1::vector, NOT taken from the
      --     query_input CTE. pgvector only recognises an ORDER BY as an index
      --     scan when the operand is a constant or a parameter; a column from a
      --     joined relation turns it into a sequential scan with one distance
      --     computation per chunk.
      --   * the ACL restriction is a WHERE qual, so the index scan can apply it
      --     while walking the graph rather than after materialising everything.
      -- The tie-breaker on c.id stays out of the ORDER BY for the same reason
      -- and is applied in the outer ranking instead.
      vector_candidates AS (
        SELECT
          chunk_id,
          document_id,
          vector_score,
          ROW_NUMBER() OVER (ORDER BY vector_score DESC, chunk_id) AS vector_rank
        FROM (
          SELECT
            c.id AS chunk_id,
            c.document_id,
            1 - (c.embedding <=> $1::vector) AS vector_score
          FROM document_chunks c
          WHERE c.embedding IS NOT NULL
            AND c.document_id IN (SELECT document_id FROM scoped_documents)
          ORDER BY c.embedding <=> $1::vector
          LIMIT $3::integer
        ) nearest_chunks
      ),
      document_keyword_matches AS (
        SELECT
          d.id AS document_id,
          GREATEST(
            CASE WHEN q.has_tsquery THEN ts_rank_cd(d.search_lookup_tsv, q.tsquery) ELSE 0 END,
            CASE WHEN q.has_tsquery_de THEN ts_rank_cd(d.search_lookup_tsv_de, q.tsquery_de) ELSE 0 END
          ) AS document_keyword_score,
          ROW_NUMBER() OVER (
            ORDER BY GREATEST(
            CASE WHEN q.has_tsquery THEN ts_rank_cd(d.search_lookup_tsv, q.tsquery) ELSE 0 END,
            CASE WHEN q.has_tsquery_de THEN ts_rank_cd(d.search_lookup_tsv_de, q.tsquery_de) ELSE 0 END
          ) DESC, d.id DESC
          ) AS document_keyword_rank
        FROM documents d
        INNER JOIN scoped_documents sd ON sd.document_id = d.id
        CROSS JOIN query_search q
        WHERE (
            (q.has_tsquery AND d.search_lookup_tsv @@ q.tsquery)
            OR (q.has_tsquery_de AND d.search_lookup_tsv_de @@ q.tsquery_de)
          )
      ),
      top_document_keyword_matches AS (
        SELECT document_id
        FROM document_keyword_matches
        WHERE document_keyword_rank <= ($3::integer * 2)
      ),
      document_keyword_seed_chunks AS (
        SELECT chunk_id
        FROM (
          SELECT
            c.id AS chunk_id,
            ROW_NUMBER() OVER (
              PARTITION BY c.document_id
              ORDER BY c.chunk_index ASC, c.id ASC
            ) AS document_chunk_rank
          FROM document_chunks c
          INNER JOIN top_document_keyword_matches dkm ON dkm.document_id = c.document_id
        ) ranked_document_chunks
        WHERE document_chunk_rank <= GREATEST($7::integer, 1)
      ),
      chunk_keyword_matches AS (
        SELECT
          c.id AS chunk_id,
          GREATEST(
            CASE WHEN q.has_tsquery THEN ts_rank_cd(c.search_content_tsv, q.tsquery) ELSE 0 END,
            CASE WHEN q.has_tsquery_de THEN ts_rank_cd(c.search_content_tsv_de, q.tsquery_de) ELSE 0 END
          ) AS chunk_keyword_score,
          ROW_NUMBER() OVER (
            ORDER BY GREATEST(
            CASE WHEN q.has_tsquery THEN ts_rank_cd(c.search_content_tsv, q.tsquery) ELSE 0 END,
            CASE WHEN q.has_tsquery_de THEN ts_rank_cd(c.search_content_tsv_de, q.tsquery_de) ELSE 0 END
          ) DESC, c.id DESC
          ) AS chunk_keyword_rank
        FROM document_chunks c
        INNER JOIN scoped_documents sd ON sd.document_id = c.document_id
        CROSS JOIN query_search q
        WHERE (
            (q.has_tsquery AND c.search_content_tsv @@ q.tsquery)
            OR (q.has_tsquery_de AND c.search_content_tsv_de @@ q.tsquery_de)
          )
      ),
      top_chunk_keyword_matches AS (
        SELECT chunk_id
        FROM chunk_keyword_matches
        WHERE chunk_keyword_rank <= ($3::integer * 4)
      ),
      keyword_seed_chunks AS (
        SELECT DISTINCT chunk_id
        FROM (
          SELECT chunk_id FROM top_chunk_keyword_matches
          UNION ALL
          SELECT chunk_id FROM document_keyword_seed_chunks
        ) keyword_seed_rows
      ),
      keyword_candidates AS (
        SELECT
          c.id AS chunk_id,
          c.document_id,
          GREATEST(
            CASE
              WHEN q.has_tsquery THEN ts_rank_cd(d.search_lookup_tsv || setweight(c.search_content_tsv, 'C'), q.tsquery)
              ELSE 0
            END,
            CASE
              WHEN q.has_tsquery_de THEN ts_rank_cd(d.search_lookup_tsv_de || setweight(c.search_content_tsv_de, 'C'), q.tsquery_de)
              ELSE 0
            END
          ) AS keyword_score,
          CASE
            WHEN qi.normalized_query IS NOT NULL AND (
              strpos(d.search_lookup_normalized, qi.normalized_query) > 0
              OR strpos(c.search_content_normalized, qi.normalized_query) > 0
            ) THEN 1
            ELSE 0
          END AS exact_match_boost,
          ROW_NUMBER() OVER (
            ORDER BY
              GREATEST(
            CASE
              WHEN q.has_tsquery THEN ts_rank_cd(d.search_lookup_tsv || setweight(c.search_content_tsv, 'C'), q.tsquery)
              ELSE 0
            END,
            CASE
              WHEN q.has_tsquery_de THEN ts_rank_cd(d.search_lookup_tsv_de || setweight(c.search_content_tsv_de, 'C'), q.tsquery_de)
              ELSE 0
            END
          ) DESC,
              CASE
            WHEN qi.normalized_query IS NOT NULL AND (
              strpos(d.search_lookup_normalized, qi.normalized_query) > 0
              OR strpos(c.search_content_normalized, qi.normalized_query) > 0
            ) THEN 1
            ELSE 0
          END DESC,
              c.id
          ) AS keyword_rank
        FROM keyword_seed_chunks k
        INNER JOIN document_chunks c ON c.id = k.chunk_id
        INNER JOIN documents d ON d.id = c.document_id
        INNER JOIN scoped_documents sd ON sd.document_id = d.id
        CROSS JOIN query_search q
        CROSS JOIN query_input qi
        WHERE (q.has_tsquery OR q.has_tsquery_de)
        ORDER BY keyword_score DESC, exact_match_boost DESC, c.id
        LIMIT $3::integer
      ),
      -- Only documents that actually surfaced in a candidate list are worth the
      -- trigram work below. Previously document_signals ran similarity() and
      -- word_similarity() over every document's first 16k characters, once per
      -- query term - a full corpus scan on every single search whenever
      -- Elasticsearch was not there to narrow the field first.
      signal_scope AS (
        SELECT DISTINCT document_id
        FROM (
          SELECT document_id FROM vector_candidates
          UNION ALL
          SELECT document_id FROM keyword_candidates
        ) candidate_document_rows
      ),
      document_base AS (
        SELECT
          d.id,
          d.source_type,
          d.search_lookup_normalized AS normalized_ref,
          d.search_text_normalized_preview AS normalized_text,
          -- Separate, shorter window for the trigram pass - see
          -- QUERY_FUZZY_TEXT_WINDOW. Exact matching below still uses the full
          -- normalized_text.
          CASE
            WHEN $12::integer > 0 THEN left(d.search_text_normalized_preview, $12::integer)
            ELSE d.search_text_normalized_preview
          END AS fuzzy_text
        FROM documents d
        INNER JOIN signal_scope ss ON ss.document_id = d.id
      ),
      document_signals AS (
        SELECT
          d.id AS document_id,
          COALESCE(term_hits.ref_hits, 0) AS ref_hits,
          COALESCE(term_hits.text_hits, 0) AS text_hits,
          COALESCE(term_hits.fuzzy_hits, 0) AS fuzzy_hits,
          COALESCE(term_hits.fuzzy_score, 0) AS fuzzy_score,
          CASE
            WHEN q.normalized_query IS NOT NULL
              AND q.normalized_query <> ''
              AND (
                d.normalized_ref LIKE '%' || replace(q.normalized_query, ' ', '%') || '%'
                OR d.normalized_text LIKE '%' || replace(q.normalized_query, ' ', '%') || '%'
              )
            THEN 1
            ELSE 0
          END AS phrase_match,
          CASE d.source_type
            WHEN 'upload' THEN 0.55
            WHEN 'sync' THEN 0.45
            WHEN 'git' THEN 0.45
            ELSE 0
          END AS source_priority,
          (
            (COALESCE(term_hits.ref_hits, 0) * 1.60)
            + (COALESCE(term_hits.text_hits, 0) * 0.12)
            + (COALESCE(term_hits.fuzzy_hits, 0) * 0.35)
            + (COALESCE(term_hits.fuzzy_score, 0) * 0.90)
            + (
              CASE
                WHEN q.normalized_query IS NOT NULL
                  AND q.normalized_query <> ''
                  AND (
                    d.normalized_ref LIKE '%' || replace(q.normalized_query, ' ', '%') || '%'
                    OR d.normalized_text LIKE '%' || replace(q.normalized_query, ' ', '%') || '%'
                  )
                THEN 1.5
                ELSE 0
              END
            )
            + CASE d.source_type
              WHEN 'upload' THEN 0.55
              WHEN 'sync' THEN 0.45
              WHEN 'git' THEN 0.45
              ELSE 0
            END
          ) AS document_match_score
        FROM document_base d
        CROSS JOIN query_input q
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE ref_hit) AS ref_hits,
            COUNT(*) FILTER (WHERE text_hit) AS text_hits,
            COUNT(*) FILTER (WHERE fuzzy >= 0.60) AS fuzzy_hits,
            COALESCE(SUM(fuzzy), 0) AS fuzzy_score
          FROM (
            SELECT
              strpos(d.normalized_ref, term) > 0 AS ref_hit,
              char_length(term) >= 4 AND strpos(d.normalized_text, term) > 0 AS text_hit,
              CASE
                WHEN char_length(term) >= 5 THEN GREATEST(
                  similarity(term, d.normalized_ref),
                  word_similarity(term, d.normalized_ref),
                  -- similarity(term, d.normalized_text) used to be part of this
                  -- GREATEST and was pure cost: it compares a query term against
                  -- the document's first 16k characters as a whole, so its
                  -- trigram overlap is vanishing - measured over this corpus it
                  -- peaks at 0.030 while word_similarity on the same text
                  -- reaches 1.0, and the fuzzy_hits threshold is 0.60. It could
                  -- therefore never win the GREATEST, but cost 84 ms per query
                  -- term across the corpus (word_similarity: 144 ms, both
                  -- lookup-field calls together: 4 ms).
                  word_similarity(term, d.fuzzy_text)
                )
                ELSE 0
              END AS fuzzy
            FROM query_terms
          ) term_signals
        ) AS term_hits ON TRUE
      ),
      combined_candidates AS (
        SELECT
          chunk_id,
          document_id,
          vector_score,
          NULL::double precision AS keyword_score,
          0 AS exact_match_boost,
          vector_rank,
          NULL::integer AS keyword_rank
        FROM vector_candidates
        UNION ALL
        SELECT
          chunk_id,
          document_id,
          NULL::double precision AS vector_score,
          keyword_score,
          exact_match_boost,
          NULL::integer AS vector_rank,
          keyword_rank
        FROM keyword_candidates
      ),
      collapsed AS (
        SELECT
          chunk_id,
          document_id,
          MAX(COALESCE(vector_score, 0)) AS vector_score,
          MAX(COALESCE(keyword_score, 0)) AS keyword_score,
          MAX(exact_match_boost) AS exact_match_boost,
          MIN(vector_rank) FILTER (WHERE vector_rank IS NOT NULL) AS vector_rank,
          MIN(keyword_rank) FILTER (WHERE keyword_rank IS NOT NULL) AS keyword_rank
        FROM combined_candidates
        GROUP BY chunk_id, document_id
      ),
      scored AS (
        SELECT
          col.chunk_id,
          col.document_id,
          ds.document_match_score,
          col.vector_score,
          col.keyword_score,
          col.exact_match_boost,
          COALESCE($4::double precision / (20 + col.vector_rank), 0)
            + COALESCE($5::double precision / (20 + col.keyword_rank), 0)
            + (col.exact_match_boost * $6::double precision)
            + (ds.document_match_score * 0.30) AS score
        FROM collapsed col
        INNER JOIN document_signals ds ON ds.document_id = col.document_id
      ),
      ranked AS (
        SELECT
          chunk_id,
          document_id,
          score,
          vector_score,
          keyword_score,
          document_match_score,
          exact_match_boost,
          ROW_NUMBER() OVER (
            PARTITION BY document_id
            ORDER BY score DESC, document_match_score DESC, keyword_score DESC, vector_score DESC, chunk_id
          ) AS document_rank
        FROM scored
      )
      -- Display columns are joined once, at the end, on the handful of rows that
      -- survive - instead of being carried through every intermediate CTE.
      SELECT
        r.chunk_id,
        r.document_id,
        d.title,
        d.source_type,
        d.source_ref,
        d.source_url,
        c.content,
        r.score,
        r.vector_score,
        r.keyword_score,
        r.document_match_score,
        r.exact_match_boost > 0 AS exact_match,
        d.metadata
      FROM ranked r
      INNER JOIN document_chunks c ON c.id = r.chunk_id
      INNER JOIN documents d ON d.id = r.document_id
      WHERE r.document_rank <= $7::integer
      ORDER BY r.score DESC, r.document_match_score DESC, r.keyword_score DESC, r.vector_score DESC, r.chunk_id
      LIMIT $8::integer
    `,
    [
      `[${embedding.join(",")}]`,
      query,
      candidateK,
      env.QUERY_VECTOR_WEIGHT,
      env.QUERY_KEYWORD_WEIGHT,
      env.QUERY_EXACT_MATCH_BOOST,
      env.QUERY_MAX_CHUNKS_PER_DOCUMENT,
      topK,
      searchOptions?.allowedKnowledgeBaseIds ?? null,
      elasticDocumentCandidateIds,
      elasticChunkCandidateIds,
      env.QUERY_FUZZY_TEXT_WINDOW
    ]
  );
  timings.sqlRetrievalMs = Date.now() - sqlStageStartedAt;

  const sqlItems: QueryItem[] = result.rows.map((row) => ({
    chunkId: Number(row.chunk_id),
    documentId: Number(row.document_id),
    title: row.title,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    sourceUrl: row.source_url,
    content: row.content,
    score: Number(row.score),
    vectorScore: Number(row.vector_score),
    keywordScore: Number(row.keyword_score),
    documentMatchScore: Number(row.document_match_score),
    exactMatch: row.exact_match,
    metadata: row.metadata,
    documentType: inferDocumentType({
      title: row.title,
      sourceRef: row.source_ref,
      sourceType: row.source_type,
      metadata: row.metadata
    })
  }));
  const items = mergeElasticsearchSignals(sqlItems, elasticChunkCandidates, elasticDocumentCandidates);

  const primaryItem = items[0];
  const filteredItems = primaryItem
    && primaryItem.documentMatchScore >= 2
    && primaryItem.sourceType !== "crawl"
    ? items.filter(
        (item) =>
          item.documentId === primaryItem.documentId
          || item.documentMatchScore >= primaryItem.documentMatchScore * 0.7
      )
    : (() => {
        const strongestLocalItem = items.find(
          (item) => item.sourceType !== "crawl" && item.documentMatchScore >= 1.1
        );

        if (!strongestLocalItem) {
          return items;
        }

        return items.filter(
          (item) =>
            item.documentId === strongestLocalItem.documentId
            || (item.sourceType !== "crawl" && item.documentMatchScore >= strongestLocalItem.documentMatchScore * 0.75)
        );
      })();

  const rawSmartFilteredItems = applySearchFilters(filteredItems, searchOptions);
  const smartFilteredItems = rawSmartFilteredItems.length > 0 || hasExplicitSearchFilters(searchOptions)
    ? rawSmartFilteredItems
    : filteredItems;
  const dominantDocumentId = getDominantDocumentId(smartFilteredItems);
  const dominantSearchDocument = dominantDocumentId !== null
    ? smartFilteredItems.find((item) => item.documentId === dominantDocumentId) ?? null
    : null;
  const effectiveSearchOptions = buildEffectiveSearchOptions(searchOptions, dominantSearchDocument);
  const dominantSearchSettings = dominantSearchDocument
    ? getItemSearchSettings(dominantSearchDocument)
    : DEFAULT_DOCUMENT_TYPE_SEARCH_SETTINGS;
  const dominantFocusQuery = dominantSearchDocument
    ? buildDocumentFocusQuery(query, `${dominantSearchDocument.title ?? ""} ${dominantSearchDocument.sourceRef}`)
    : query;
  const refinementStageStartedAt = Date.now();
  const narrativeRefinedItems = dominantDocumentId !== null
    && effectiveSearchOptions.preferDocumentFocus
    && dominantSearchSettings.searchProfile === "narrative"
    ? await refineNarrativeSectionsWithinDocument(dominantDocumentId, dominantFocusQuery, Math.max(topK * 3, 12))
    : [];
  const documentRefinedItems = narrativeRefinedItems.length > 0
    ? narrativeRefinedItems
    : dominantDocumentId !== null && effectiveSearchOptions.preferDocumentFocus
      ? await refineItemsWithinDocument(dominantDocumentId, query, Math.max(topK * 3, 12))
      : [];
  timings.refinementMs = Date.now() - refinementStageStartedAt;
  const combinedSmartItems = documentRefinedItems.length >= Math.max(3, Math.ceil(topK / 2))
    ? documentRefinedItems
    : documentRefinedItems.length > 0
      ? [
          ...documentRefinedItems,
          ...smartFilteredItems.filter(
            (item) => !documentRefinedItems.some((refinedItem) => refinedItem.chunkId === item.chunkId)
          )
        ]
      : smartFilteredItems;
  const rerankQuery = dominantDocumentId !== null && effectiveSearchOptions.preferDocumentFocus
    ? dominantFocusQuery
    : query;
  const rerankStageStartedAt = Date.now();
  const rerankOutcome = searchOptions?.enableRerank === false
    ? { items: combinedSmartItems, usedCrossEncoder: false }
    : await rerankItemsWithCrossEncoder(combinedSmartItems, rerankQuery, effectiveSearchOptions);
  const rerankedItems = rerankOutcome.items;
  timings.rerankMs = Date.now() - rerankStageStartedAt;
  const adjacencyBiasedItems = dominantDocumentId !== null && effectiveSearchOptions.preferAdjacentSections
    ? applyAdjacentSectionBias(rerankedItems, dominantDocumentId, effectiveSearchOptions.adjacentSectionWindow ?? 1)
    : rerankedItems;
  const focusFilteredItems = dominantDocumentId !== null && effectiveSearchOptions.requireFocusTerms
    ? filterItemsByFocusTerms(adjacencyBiasedItems, dominantFocusQuery)
    : adjacencyBiasedItems;
  const expansionStageStartedAt = Date.now();
  const expandedItems = searchOptions?.enableSmallToBig === false
    ? focusFilteredItems.slice(0, topK)
    : await applySmallToBigWithWindow(focusFilteredItems, topK, effectiveSearchOptions.smallToBigWindow);
  timings.expansionMs = Date.now() - expansionStageStartedAt;
  const enrichmentStageStartedAt = Date.now();
  const finalItems = await attachOriginalFiles(expandedItems.slice(0, topK));
  timings.enrichmentMs = Date.now() - enrichmentStageStartedAt;

  const sources = buildOpenWebUiSources(finalItems);

  const dominantDocument = finalItems[0];
  const answerGuidance = dominantDocument && dominantDocument.documentMatchScore >= 1.5
    ? [
        "The question is answerable from the retrieved excerpts.",
        "Answer directly from the retrieved document content.",
        "Do not refuse on privacy or access grounds because the retrieval tool already returned authorized material.",
        dominantDocument.sourceRef
          ? `Primary document: ${dominantDocument.sourceRef}.`
          : "Use the most relevant retrieved document as the primary source."
      ].join(" ")
    : "Answer only from the retrieved excerpts. If they are insufficient, say that clearly.";

  logger.debug({
    query,
    topK,
    candidateK,
    elasticChunkCandidateCount: elasticChunkCandidates?.length ?? 0,
    elasticDocumentCandidateCount: elasticDocumentCandidates?.length ?? 0,
    sqlRowCount: result.rows.length,
    finalItemCount: finalItems.length,
    crossEncoderRerank: rerankOutcome.usedCrossEncoder,
    timings: {
      ...timings,
      totalMs: Date.now() - startedAt
    }
  }, "similarity query completed");

  return {
    query,
    model,
    topK,
    context: finalItems.map((item) => item.content).join("\n\n---\n\n"),
    items: finalItems,
    sources,
    citations: sources,
    mode: "similarity",
    answerGuidance
  };
}

function normalizeQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function isDocumentInventoryQuery(query: string): boolean {
  const terms = normalizeQueryTerms(query);
  if (terms.length === 0) {
    return false;
  }

  const stopTerms = new Set([
    "was", "waren", "welche", "welcher", "welches", "gibt", "gab", "gib", "zeige", "list", "liste",
    "auflisten", "vorhanden", "sind", "ist", "es", "mir", "an", "auf", "zu", "zum", "zur", "im",
    "in", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einem", "und", "oder"
  ]);
  const inventoryTerms = new Set([
    "dokument", "dokumente", "dokumenten", "datei", "dateien", "unterlage", "unterlagen",
    "quelle", "quellen", "protokoll", "protokolle", "akten", "inhalte"
  ]);

  const significantTerms = terms.filter((term) => !stopTerms.has(term));
  if (significantTerms.length === 0) {
    return false;
  }

  const hasInventoryTerm = significantTerms.some((term) => inventoryTerms.has(term));
  if (!hasInventoryTerm) {
    return false;
  }

  return significantTerms.every((term) => inventoryTerms.has(term));
}

export async function executeDocumentInventoryQuery(query: string, topK: number, model: string, allowedKnowledgeBaseIds?: number[]): Promise<QueryResponse> {
  const result = await pool.query<DocumentInventoryRow>(
    `
      SELECT
        d.id AS document_id,
        d.title,
        d.source_type,
        d.source_ref,
        d.source_url,
        d.file_type,
        d.created_at::text,
        d.metadata,
        LEFT(COALESCE(c.content, d.extracted_text, ''), 600) AS preview
      FROM documents d
      LEFT JOIN LATERAL (
        SELECT content
        FROM document_chunks
        WHERE document_id = d.id
        ORDER BY id
        LIMIT 1
      ) c ON TRUE
      WHERE (
          $2::bigint[] IS NULL
          OR (cardinality($2::bigint[]) > 0 AND d.knowledge_base_id = ANY($2::bigint[]))
        )
        AND (
          d.source_type <> 'crawl'
         OR NOT EXISTS (
           SELECT 1
           FROM documents local_documents
           WHERE local_documents.source_type <> 'crawl'
         )
        )
      ORDER BY
        CASE d.source_type
          WHEN 'upload' THEN 0
          WHEN 'sync' THEN 1
          ELSE 2
        END,
        d.created_at DESC,
        d.id DESC
      LIMIT $1::integer
    `,
    [Math.max(topK, 12), allowedKnowledgeBaseIds ?? null]
  );

  const items: QueryItem[] = result.rows.map((row, index) => {
    const metadata = row.metadata ?? {};
    const uploadedFileName = typeof metadata.uploadedFileName === "string" ? metadata.uploadedFileName : null;
    const displayTitle = uploadedFileName ?? row.title ?? row.source_ref;
    const preview = (row.preview ?? "").trim();
    const contentLines = [
      `Dokument: ${displayTitle}`,
      `Quelle: ${row.source_ref}`,
      `Typ: ${row.source_type}`,
      ...(row.file_type ? [`Dateityp: ${row.file_type}`] : []),
      ...(row.source_url ? [`URL: ${row.source_url}`] : []),
      `Erfasst: ${new Date(row.created_at).toISOString().slice(0, 10)}`,
      ...(preview ? [`Vorschau: ${preview}`] : [])
    ];

    return {
      chunkId: -(index + 1),
      // pg gibt bigint als String zurueck; ohne Number() vergleicht sich die
      // Dokument-Id spaeter nicht mit den numerischen Schluesseln der Aufrufer.
      documentId: Number(row.document_id),
      title: displayTitle,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      sourceUrl: row.source_url,
      content: contentLines.join("\n"),
      score: Math.max(1, 10 - index * 0.1),
      vectorScore: 0,
      keywordScore: 0,
      documentMatchScore: row.source_type === "upload" ? 2 : row.source_type === "sync" ? 1.8 : 0.5,
      exactMatch: true,
      metadata,
      documentType: inferDocumentType({
        title: row.title,
        sourceRef: row.source_ref,
        sourceType: row.source_type,
        fileType: row.file_type,
        metadata
      })
    };
  });

  const finalItems = await attachOriginalFiles(items.slice(0, topK));
  const sources = buildOpenWebUiSources(finalItems);

  return {
    query,
    model,
    topK,
    context: finalItems.map((item) => item.content).join("\n\n---\n\n"),
    items: finalItems,
    sources,
    citations: sources,
    mode: "inventory",
    answerGuidance: "The user asked for an inventory of available documents. List the returned documents clearly, prioritizing uploaded or synced local documents over crawled web pages."
  };
}

export async function executeQuery(
  query: string,
  topK: number,
  model: string,
  vectorService = new VectorService(),
  searchOptions?: SearchOptions,
  allowedKnowledgeBaseIds?: number[]
): Promise<QueryResponse> {
  return isDocumentInventoryQuery(query)
    ? executeDocumentInventoryQuery(query, topK, model, allowedKnowledgeBaseIds)
    : executeSimilarityQuery(query, topK, model, vectorService, {
        ...searchOptions,
        allowedKnowledgeBaseIds: allowedKnowledgeBaseIds ?? searchOptions?.allowedKnowledgeBaseIds
      });
}

export async function executeSmartSearchQuery(options: {
  query: string;
  topK: number;
  model: string;
  category?: string;
  documentType?: string;
  sourceTypes?: string[];
  fileTypes?: string[];
  enableRerank?: boolean;
  enableSmallToBig?: boolean;
  preferDocumentFocus?: boolean;
  preferAdjacentSections?: boolean;
  requireFocusTerms?: boolean;
  allowedKnowledgeBaseIds?: number[];
}): Promise<QueryResponse> {
  return executeSimilarityQuery(
    options.query,
    options.topK,
    options.model,
    new VectorService(),
    {
      category: options.category,
      documentType: options.documentType,
      sourceTypes: options.sourceTypes,
      fileTypes: options.fileTypes,
      enableRerank: options.enableRerank ?? true,
      enableSmallToBig: options.enableSmallToBig ?? true,
      preferDocumentFocus: options.preferDocumentFocus,
      preferAdjacentSections: options.preferAdjacentSections,
      requireFocusTerms: options.requireFocusTerms,
      allowedKnowledgeBaseIds: options.allowedKnowledgeBaseIds
    }
  );
}

export async function executeDocumentContextQuery(options: {
  sourceRef?: string;
  documentId?: number;
  query?: string;
  maxChunks?: number;
  allowedKnowledgeBaseIds?: number[];
}): Promise<QueryResponse | null> {
  const trimmedSourceRef = options.sourceRef?.trim();
  const trimmedQuery = options.query?.trim() ?? "";
  const maxChunks = Math.min(Math.max(options.maxChunks ?? 5, 1), 12);

  if (!trimmedSourceRef && !options.documentId) {
    return null;
  }

  const result = await pool.query<DocumentContextRow>(
    `
      WITH selected_document AS (
        SELECT
          d.id,
          d.title,
          d.source_type,
          d.source_ref,
          d.source_url,
          d.metadata
        FROM documents d
        WHERE (
            $5::bigint[] IS NULL
            OR (cardinality($5::bigint[]) > 0 AND d.knowledge_base_id = ANY($5::bigint[]))
          )
          AND (
            ($1::bigint IS NOT NULL AND d.id = $1::bigint)
           OR (
             $2::text IS NOT NULL
             AND (
               lower(d.source_ref) = lower($2::text)
               OR lower(COALESCE(d.title, '')) = lower($2::text)
               OR lower(d.source_ref) LIKE '%' || lower($2::text) || '%'
               OR lower(COALESCE(d.title, '')) LIKE '%' || lower($2::text) || '%'
             )
            )
          )
        ORDER BY
          CASE
            WHEN $1::bigint IS NOT NULL AND d.id = $1::bigint THEN 0
            WHEN $2::text IS NOT NULL AND lower(d.source_ref) = lower($2::text) THEN 1
            WHEN $2::text IS NOT NULL AND lower(COALESCE(d.title, '')) = lower($2::text) THEN 2
            WHEN $2::text IS NOT NULL AND lower(d.source_ref) LIKE '%' || lower($2::text) || '%' THEN 3
            ELSE 4
          END,
          d.updated_at DESC,
          d.id DESC
        LIMIT 1
      ),
      query_terms AS (
        SELECT DISTINCT term
        FROM regexp_split_to_table(lower(regexp_replace($3::text, '[^[:alnum:]]+', ' ', 'g')), '\\s+') AS term
        WHERE char_length(term) >= 3
      ),
      query_search AS (
        SELECT
          tsquery,
          tsquery_de,
          (tsquery IS NOT NULL AND numnode(tsquery) > 0) AS has_tsquery,
          (tsquery_de IS NOT NULL AND numnode(tsquery_de) > 0) AS has_tsquery_de
        FROM (
          SELECT
            CASE
              WHEN EXISTS (SELECT 1 FROM query_terms)
                THEN to_tsquery('simple', (SELECT string_agg(term, ' | ') FROM query_terms))
              ELSE NULL
            END AS tsquery,
            -- German stemming and stop words, so "Dienstplaene" matches "Dienstplan".
            -- Added NEXT TO the 'simple' query rather than replacing it: only 'simple'
            -- still matches file names, Aktenzeichen and identifiers verbatim, and the
            -- German stemmer would mangle exactly those. Every site below takes the
            -- better of the two ranks (see migrations/021_german_text_search.sql).
            CASE
              WHEN EXISTS (SELECT 1 FROM query_terms)
                THEN to_tsquery('german', (SELECT string_agg(term, ' | ') FROM query_terms))
              ELSE NULL
            END AS tsquery_de
        ) built_queries
      )
      SELECT
        d.id AS document_id,
        d.title,
        d.source_type,
        d.source_ref,
        d.source_url,
        c.id AS chunk_id,
        c.chunk_index,
        c.content,
        c.metadata,
        d.metadata AS document_metadata,
        GREATEST(
          CASE WHEN qs.has_tsquery THEN ts_rank_cd(c.search_content_tsv, qs.tsquery) ELSE 0 END,
          CASE WHEN qs.has_tsquery_de THEN ts_rank_cd(c.search_content_tsv_de, qs.tsquery_de) ELSE 0 END
        ) AS keyword_score
      FROM selected_document d
      INNER JOIN document_chunks c ON c.document_id = d.id
      CROSS JOIN query_search qs
      ORDER BY
        CASE WHEN qs.has_tsquery OR qs.has_tsquery_de THEN 1 ELSE 0 END DESC,
        keyword_score DESC,
        c.chunk_index ASC,
        c.id ASC
      LIMIT $4::integer
    `,
    [options.documentId ?? null, trimmedSourceRef ?? null, trimmedQuery, maxChunks, options.allowedKnowledgeBaseIds ?? null]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const items: QueryItem[] = result.rows.map((row, index) => ({
    chunkId: row.chunk_id,
    documentId: Number(row.document_id),
    title: row.title,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    sourceUrl: row.source_url,
    content: row.content,
    score: Math.max(1, 5 - index * 0.05),
    vectorScore: 0,
    keywordScore: Number(row.keyword_score),
    documentMatchScore: 2.5,
    exactMatch: Boolean(trimmedSourceRef),
    metadata: {
      ...row.document_metadata,
      ...(row.metadata ?? {})
    }
  }));

  const document = items[0];
  const sources = buildOpenWebUiSources(items);

  return {
    query: trimmedQuery || trimmedSourceRef || String(options.documentId),
    model: await getEmbeddingModelName(),
    topK: maxChunks,
    context: items.map((item) => item.content).join("\n\n---\n\n"),
    items,
    sources,
    citations: sources,
    mode: "similarity",
    answerGuidance: `Use the retrieved excerpts from ${document.sourceRef} as the primary source for the answer.`
  };
}

export async function executeDocumentFulltextQuery(options: {
  documentId?: number;
  sourceRef?: string;
  maxChars?: number;
  allowedKnowledgeBaseIds?: number[];
}): Promise<DocumentFulltextResponse | null> {
  const document = await findDocument(options);
  if (!document) {
    return null;
  }

  const requestedMaxChars = options.maxChars ?? 40000;
  const maxChars = Math.min(Math.max(requestedMaxChars, 1000), 200000);
  const truncated = document.extractedText.length > maxChars;
  const originalFile = await getDocumentFile(document.id);

  return {
    document,
    fulltext: truncated ? `${document.extractedText.slice(0, maxChars)}\n\n[TRUNCATED]` : document.extractedText,
    truncated,
    totalLength: document.extractedText.length,
    originalFile
  };
}

export async function executeDocumentStructureQuery(options: {
  documentId?: number;
  sourceRef?: string;
  limit?: number;
  allowedKnowledgeBaseIds?: number[];
}): Promise<DocumentStructureResponse | null> {
  return getDocumentStructure(options);
}

export async function executeDocumentOriginalQuery(options: {
  documentId?: number;
  sourceRef?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<DocumentOriginalResponse | null> {
  const document = await findDocument(options);
  if (!document) {
    return null;
  }

  const originalFile = await getDocumentFile(document.id);
  return {
    document,
    originalFile
  };
}

export async function executeDocumentSectionsQuery(options: {
  documentId?: number;
  sourceRef?: string;
  query?: string;
  limit?: number;
  allowedKnowledgeBaseIds?: number[];
}): Promise<DocumentSectionsResponse | null> {
  return getDocumentSections(options);
}

export async function executeSingleDocumentSectionQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<DocumentSectionResponse | null> {
  return getDocumentSection(options);
}

export async function executeMeetingActionsQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractMeetingActions(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeDecisionsQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractDecisions(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeDeadlinesQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractDeadlines(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeRequirementsQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractRequirements(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeConfigKeysQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractConfigKeys(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeSetupStepsQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractSetupSteps(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeApiSurfaceQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractApiSurface(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeOperationalNotesQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractOperationalNotes(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeRisksQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractRisks(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeEntitiesQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<AnalysisResponse | null> {
  try {
    return await analysisService.extractEntities(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeDocumentSummaryQuery(options: {
  documentId?: number;
  sourceRef?: string;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<SummaryResponse | null> {
  try {
    return await analysisService.summarizeDocument(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeCompareDocumentsQuery(options: {
  leftDocumentId?: number;
  leftSourceRef?: string;
  rightDocumentId?: number;
  rightSourceRef?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<DocumentComparisonResponse | null> {
  try {
    return await analysisService.compareDocuments(options);
  } catch (error) {
    if (error instanceof Error && error.message === "document not found") {
      return null;
    }
    throw error;
  }
}

export async function executeCompareDocumentVersionsQuery(options: {
  documentId?: number;
  sourceRef?: string;
  previousDocumentId?: number;
  previousSourceRef?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<DocumentComparisonResponse | null> {
  try {
    return await analysisService.compareDocumentVersions(options);
  } catch (error) {
    if (error instanceof Error && ["document not found", "previous document version not found"].includes(error.message)) {
      return null;
    }
    throw error;
  }
}

export async function executeCrossReferenceQuery(options: {
  topic: string;
  limit?: number;
  allowedKnowledgeBaseIds?: number[];
}): Promise<TopicCrossReferenceResponse> {
  return analysisService.crossReferenceTopic(options);
}

export async function executeSectionSummaryQuery(options: {
  documentId?: number;
  sourceRef?: string;
  sectionIndex?: number;
  query?: string;
  allowedKnowledgeBaseIds?: number[];
}): Promise<SummaryResponse | null> {
  try {
    return await analysisService.summarizeDocumentSection(options);
  } catch (error) {
    if (error instanceof Error && ["document not found", "no document section found"].includes(error.message)) {
      return null;
    }
    throw error;
  }
}

function buildOpenWebUiSources(items: QueryItem[]): OpenWebUiSource[] {
  const groupedSources = new Map<string, OpenWebUiSource>();

  for (const item of items) {
    const uploadedFileName = typeof item.metadata.uploadedFileName === "string" ? item.metadata.uploadedFileName : null;
    const sourceId = item.sourceUrl ?? item.sourceRef ?? `document-${item.documentId}`;
    const sourceName = uploadedFileName ?? item.title ?? item.sourceRef ?? `Document ${item.documentId}`;
    const existingSource = groupedSources.get(sourceId);

    const metadata: Record<string, unknown> = {
      source: sourceId,
      name: sourceName,
      document_id: item.documentId,
      chunk_id: item.chunkId,
      score: item.score,
      vector_score: item.vectorScore,
      keyword_score: item.keywordScore,
      document_match_score: item.documentMatchScore,
      exact_match: item.exactMatch,
      document_type: item.documentType,
      source_ref: item.sourceRef,
      source_type: item.sourceType,
      ...(item.sourceUrl ? { url: item.sourceUrl } : {}),
      ...(item.originalFile
        ? {
            original_download_url: item.originalFile.downloadUrl,
            original_name: item.originalFile.originalName,
            original_local_available: item.originalFile.localAvailable,
            original_external_url: item.originalFile.externalUrl
          }
        : {}),
      ...(item.metadata && Object.keys(item.metadata).length > 0 ? { rag_metadata: item.metadata } : {})
    };

    if (existingSource) {
      existingSource.document.push(item.content);
      existingSource.metadata.push(metadata);
      existingSource.distances.push(item.score);
      continue;
    }

    groupedSources.set(sourceId, {
      source: {
        id: sourceId,
        name: sourceName,
        type: item.sourceType,
        ...(item.sourceUrl ? { url: item.sourceUrl } : {}),
        ...(item.originalFile?.downloadUrl ? { originalDownloadUrl: item.originalFile.downloadUrl } : {})
      },
      document: [item.content],
      metadata: [metadata],
      distances: [item.score]
    });
  }

  return [...groupedSources.values()];
}

function normalizeTopK(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) {
    return env.QUERY_TOP_K;
  }

  return Math.min(50, Math.floor(value));
}

export function createApiRouter(schedulerService: SchedulerService) {
  const router = express.Router();

  router.use((request, response, next) => {
    if (response.locals.isAdminAuthenticated || response.locals.apiPrincipal) {
      next();
      return;
    }

    const token = extractApiToken(request);
    if (!token) {
      next();
      return;
    }

    hasEnabledMcpPrincipals()
      .then(async (authenticationRequired) => {
        if (!authenticationRequired) {
          next();
          return;
        }

        const principal = await resolveMcpPrincipalByToken(token);
        if (!principal) {
          response.status(401).json({ error: "invalid MCP access token" });
          return;
        }

        response.locals.apiPrincipal = principal;
        next();
      })
      .catch(next);
  });

  router.get("/status", async (_request, response, next) => {
    try {
      const counts = await getCounts();
      let aiProviderReachable = false;
      let aiProviderError: string | null = null;
      const elasticsearch = await searchIndexService.checkHealth();
      const elasticsearchIndices = elasticsearch.reachable
        ? await searchIndexService.getIndexStats()
        : null;
      const aiProviderSettings = await getAiProviderSettings();
      const aiProviderConnection = await getAiProviderConnection();

      try {
        await checkAiProviderReachable(aiProviderConnection, 5_000);
        aiProviderReachable = true;
      } catch (error) {
        aiProviderError = error instanceof Error ? error.message : "unknown error";
      }

      response.json({
        counts,
        config: {
          aiProvider: aiProviderSettings.provider,
          ollamaBaseUrl: aiProviderSettings.baseUrl,
          embeddingModel: aiProviderSettings.embeddingModel,
          llmModel: aiProviderSettings.summaryModel,
          documentClassifierModel: aiProviderSettings.classifierModel,
          documentTypeCount: getEnabledDocumentTypeSettingsSnapshot().length,
          importDir: env.IMPORT_DIR,
          gitRepoCacheDir: env.GIT_REPO_CACHE_DIR,
          gitRepoMaxFileBytes: env.GIT_REPO_MAX_FILE_BYTES,
          elasticsearchUrl: env.ELASTICSEARCH_URL ?? null,
          elasticsearchIndexPrefix: env.ELASTICSEARCH_INDEX_PREFIX
        },
        ollamaReachable: aiProviderReachable,
        ollamaError: aiProviderError,
        elasticsearch: {
          ...elasticsearch,
          indices: elasticsearchIndices
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/config", async (_request, response, next) => {
    try {
      const aiProviderSettings = await getAiProviderSettings();
      response.json({
        port: env.PORT,
        aiProvider: aiProviderSettings.provider,
        ollamaBaseUrl: aiProviderSettings.baseUrl,
        embeddingModel: aiProviderSettings.embeddingModel,
        llmModel: aiProviderSettings.summaryModel,
        documentClassifierModel: aiProviderSettings.classifierModel,
        documentTypeCount: getEnabledDocumentTypeSettingsSnapshot().length,
        embeddingDimension: aiProviderSettings.embeddingDimension,
        queryTopK: env.QUERY_TOP_K,
        queryCandidateK: env.QUERY_CANDIDATE_K,
        queryMaxChunksPerDocument: env.QUERY_MAX_CHUNKS_PER_DOCUMENT,
        queryVectorWeight: env.QUERY_VECTOR_WEIGHT,
        queryKeywordWeight: env.QUERY_KEYWORD_WEIGHT,
        queryExactMatchBoost: env.QUERY_EXACT_MATCH_BOOST,
        queryRerankTopN: env.QUERY_RERANK_TOP_N,
        querySmallToBigWindow: env.QUERY_SMALL_TO_BIG_WINDOW,
        chunkSize: env.CHUNK_SIZE,
        chunkOverlap: env.CHUNK_OVERLAP,
        importDir: env.IMPORT_DIR,
        uploadDir: env.UPLOAD_DIR,
        originalStorageDir: env.ORIGINAL_STORAGE_DIR,
        gitRepoCacheDir: env.GIT_REPO_CACHE_DIR,
        gitRepoMaxFileBytes: env.GIT_REPO_MAX_FILE_BYTES,
        elasticsearchUrl: env.ELASTICSEARCH_URL ?? null,
        elasticsearchIndexPrefix: env.ELASTICSEARCH_INDEX_PREFIX,
        publicBaseUrl: env.PUBLIC_BASE_URL ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/knowledge-bases", async (_request, response, next) => {
    try {
      response.json(await listKnowledgeBases());
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/knowledge-bases", async (request, response, next) => {
    try {
      const knowledgeBase = await createKnowledgeBase({
        name: String(request.body.name ?? ""),
        slug: typeof request.body.slug === "string" ? request.body.slug : undefined,
        description: typeof request.body.description === "string" ? request.body.description : undefined,
        isEnabled: request.body.isEnabled === undefined ? true : Boolean(request.body.isEnabled)
      });
      response.status(201).json(knowledgeBase);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/knowledge-bases/:id", async (request, response, next) => {
    try {
      const knowledgeBaseId = Number(request.params.id);
      if (!Number.isFinite(knowledgeBaseId) || knowledgeBaseId <= 0) {
        response.status(400).json({ error: "knowledge base id must be a positive number" });
        return;
      }

      const knowledgeBase = await updateKnowledgeBase(knowledgeBaseId, {
        name: String(request.body.name ?? ""),
        slug: typeof request.body.slug === "string" ? request.body.slug : undefined,
        description: typeof request.body.description === "string" ? request.body.description : undefined,
        isEnabled: request.body.isEnabled === undefined ? true : Boolean(request.body.isEnabled)
      });

      if (!knowledgeBase) {
        response.status(404).json({ error: "knowledge base not found" });
        return;
      }

      response.json(knowledgeBase);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/knowledge-bases/:id", async (request, response, next) => {
    try {
      const knowledgeBaseId = Number(request.params.id);
      if (!Number.isFinite(knowledgeBaseId) || knowledgeBaseId <= 0) {
        response.status(400).json({ error: "knowledge base id must be a positive number" });
        return;
      }

      const deleted = await deleteKnowledgeBase(knowledgeBaseId);
      if (!deleted) {
        response.status(404).json({ error: "knowledge base not found" });
        return;
      }

      response.status(204).end();
    } catch (error) {
      if (error instanceof Error && error.message === "knowledge base still has assigned documents") {
        response.status(409).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post("/admin/change-password", async (request, response, next) => {
    try {
      if (!response.locals.isAdminAuthenticated || typeof response.locals.adminUsername !== "string") {
        response.status(401).json({ error: "admin authentication required" });
        return;
      }

      const currentPassword = String(request.body.currentPassword ?? "");
      const newPassword = String(request.body.newPassword ?? "");
      const confirmPassword = String(request.body.confirmPassword ?? "");

      if (!currentPassword) {
        response.status(400).json({ error: "current password is required" });
        return;
      }

      if (!newPassword) {
        response.status(400).json({ error: "new password is required" });
        return;
      }

      if (newPassword !== confirmPassword) {
        response.status(400).json({ error: "new password and confirmation do not match" });
        return;
      }

      await changeAdminPassword(response.locals.adminUsername, currentPassword, newPassword);
      response.json({ ok: true });
    } catch (error) {
      if (error instanceof Error && [
        "current password is required",
        "new password is required",
        "new password must be at least 6 characters long",
        "current password is invalid"
      ].includes(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }

      next(error);
    }
  });

  router.get("/admin/users", async (_request, response, next) => {
    try {
      response.json(await listAdminUsers());
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/document-types", async (_request, response, next) => {
    try {
      await ensureDocumentTypeSettingsLoaded();
      response.json(getDocumentTypeSettingsSnapshot());
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/ragfind/settings", async (_request, response, next) => {
    try {
      response.json(await getRagfindSettings());
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/ragfind/settings", async (request, response, next) => {
    try {
      const knowledgeBaseIds = Array.isArray(request.body.knowledgeBaseIds)
        ? request.body.knowledgeBaseIds
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isFinite(value) && value > 0)
        : [];

      response.json(await updateRagfindSettings({ knowledgeBaseIds }));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/document-types/:key", async (request, response, next) => {
    try {
      const key = String(request.params.key ?? "").trim().toLowerCase();
      if (!key) {
        response.status(400).json({ error: "document type key is required" });
        return;
      }

      const updated = await updateDocumentTypeSetting(key, {
        label: typeof request.body.label === "string" ? request.body.label : undefined,
        description: typeof request.body.description === "string" ? request.body.description : undefined,
        category: typeof request.body.category === "string" ? request.body.category : undefined,
        promptHint: typeof request.body.promptHint === "string" ? request.body.promptHint : undefined,
        keywords: Array.isArray(request.body.keywords) ? request.body.keywords : undefined,
        sourceTypeHints: Array.isArray(request.body.sourceTypeHints) ? request.body.sourceTypeHints : undefined,
        fileTypeHints: Array.isArray(request.body.fileTypeHints) ? request.body.fileTypeHints : undefined,
        enabled: typeof request.body.enabled === "boolean" ? request.body.enabled : undefined,
        priority: typeof request.body.priority === "number" ? request.body.priority : undefined,
        searchSettings: request.body.searchSettings && typeof request.body.searchSettings === "object"
          ? {
              searchProfile: typeof request.body.searchSettings.searchProfile === "string"
                ? request.body.searchSettings.searchProfile
                : undefined,
              preferContentMatches: typeof request.body.searchSettings.preferContentMatches === "boolean"
                ? request.body.searchSettings.preferContentMatches
                : undefined,
              preferDocumentFocus: typeof request.body.searchSettings.preferDocumentFocus === "boolean"
                ? request.body.searchSettings.preferDocumentFocus
                : undefined,
              requireFocusTerms: typeof request.body.searchSettings.requireFocusTerms === "boolean"
                ? request.body.searchSettings.requireFocusTerms
                : undefined,
              preferAdjacentSections: typeof request.body.searchSettings.preferAdjacentSections === "boolean"
                ? request.body.searchSettings.preferAdjacentSections
                : undefined,
              adjacentSectionWindow: typeof request.body.searchSettings.adjacentSectionWindow === "number"
                ? request.body.searchSettings.adjacentSectionWindow
                : undefined,
              smallToBigWindow: typeof request.body.searchSettings.smallToBigWindow === "number"
                ? request.body.searchSettings.smallToBigWindow
                : undefined
            }
          : undefined,
        chunkingSettings: request.body.chunkingSettings && typeof request.body.chunkingSettings === "object"
          ? {
              chunkSize: request.body.chunkingSettings.chunkSize === null || typeof request.body.chunkingSettings.chunkSize === "number"
                ? request.body.chunkingSettings.chunkSize
                : undefined,
              overlap: request.body.chunkingSettings.overlap === null || typeof request.body.chunkingSettings.overlap === "number"
                ? request.body.chunkingSettings.overlap
                : undefined
            }
          : undefined
      });

      if (!updated) {
        response.status(404).json({ error: "document type not found" });
        return;
      }

      response.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/users", async (request, response, next) => {
    try {
      const username = String(request.body.username ?? "");
      const password = String(request.body.password ?? "");
      const confirmPassword = String(request.body.confirmPassword ?? "");

      if (password !== confirmPassword) {
        response.status(400).json({ error: "password and confirmation do not match" });
        return;
      }

      const user = await createAdminUser(username, password);
      response.status(201).json(user);
    } catch (error) {
      if (error instanceof Error && [
        "username is required",
        "username must be 3-64 characters and use only letters, numbers, dot, underscore or hyphen",
        "new password must be at least 5 characters long",
        "admin user already exists"
      ].includes(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }

      next(error);
    }
  });

  router.post("/admin/search/reindex", async (request, response, next) => {
    try {
      if (!response.locals.isAdminAuthenticated) {
        response.status(401).json({ error: "admin authentication required" });
        return;
      }

      const requestedBatchSize = Number(request.body.batchSize ?? 100);
      const requestedMaxDocuments = request.body.maxDocuments == null ? undefined : Number(request.body.maxDocuments);
      const batchSize = Number.isFinite(requestedBatchSize) && requestedBatchSize > 0
        ? Math.min(Math.floor(requestedBatchSize), 1000)
        : 100;
      const maxDocuments = typeof requestedMaxDocuments === "number"
        && Number.isFinite(requestedMaxDocuments)
        && requestedMaxDocuments > 0
        ? Math.min(Math.floor(requestedMaxDocuments), 100000)
        : undefined;

      const result = await searchIndexService.backfillDocuments(batchSize, maxDocuments);
      await searchIndexService.refreshIndices();
      const indices = await searchIndexService.getIndexStats();
      response.json({
        ok: true,
        ...result,
        batchSize,
        maxDocuments: maxDocuments ?? null,
        indices
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/classification/reindex", async (request, response, next) => {
    try {
      if (!response.locals.isAdminAuthenticated) {
        response.status(401).json({ error: "admin authentication required" });
        return;
      }

      const requestedBatchSize = Number(request.body.batchSize ?? 25);
      const requestedMaxDocuments = request.body.maxDocuments == null ? undefined : Number(request.body.maxDocuments);
      const batchSize = Number.isFinite(requestedBatchSize) && requestedBatchSize > 0
        ? Math.min(Math.floor(requestedBatchSize), 200)
        : 25;
      const maxDocuments = typeof requestedMaxDocuments === "number"
        && Number.isFinite(requestedMaxDocuments)
        && requestedMaxDocuments > 0
        ? Math.min(Math.floor(requestedMaxDocuments), 10_000)
        : undefined;
      const force = Boolean(request.body.force);

      const result = await documentClassificationService.backfillDocuments({
        batchSize,
        maxDocuments,
        force
      });

      response.json({
        ok: true,
        ...result,
        batchSize,
        maxDocuments: maxDocuments ?? null,
        force
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/embeddings/reembed", async (request, response, next) => {
    try {
      if (!response.locals.isAdminAuthenticated) {
        response.status(401).json({ error: "admin authentication required" });
        return;
      }

      const activeAiProviderSettings = await getAiProviderSettings();
      const targetModel = typeof request.body.targetModel === "string" && request.body.targetModel.trim()
        ? request.body.targetModel.trim()
        : activeAiProviderSettings.embeddingModel;
      const requestedDimension = Number(request.body.targetDimension ?? activeAiProviderSettings.embeddingDimension);
      const targetDimension = Number.isFinite(requestedDimension) && requestedDimension > 0
        ? Math.floor(requestedDimension)
        : activeAiProviderSettings.embeddingDimension;
      const requestedBatchSize = Number(request.body.batchSize ?? 50);
      const batchSize = Number.isFinite(requestedBatchSize) && requestedBatchSize > 0
        ? Math.min(Math.floor(requestedBatchSize), 500)
        : 50;

      // Without `force` this only picks up chunks whose model differs. After an
      // embedding-input change (context header, task prefix) the model name is
      // unchanged, so the run would find nothing - that is what force is for.
      const force = request.body.force === true || request.body.force === "true";

      const job = await reembedQueue.add("reembed", { targetModel, targetDimension, batchSize, force });
      response.status(202).json({ jobId: job.id, targetModel, targetDimension, batchSize, force });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/embeddings/pending-status", async (_request, response, next) => {
    try {
      if (!response.locals.isAdminAuthenticated) {
        response.status(401).json({ error: "admin authentication required" });
        return;
      }

      const counts = await pool.query<{ embedding_status: string; count: string }>(
        `
          SELECT embedding_status, COUNT(*)::bigint AS count
          FROM document_chunks
          GROUP BY embedding_status
        `
      );

      let pending = 0;
      let completed = 0;
      let failed = 0;
      for (const row of counts.rows) {
        const value = Number(row.count);
        if (row.embedding_status === "pending") {
          pending = value;
        } else if (row.embedding_status === "completed") {
          completed = value;
        } else if (row.embedding_status === "failed") {
          failed = value;
        }
      }

      response.json({ pending, completed, failed, total: pending + completed + failed });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/ai-provider/settings", async (_request, response, next) => {
    try {
      if (!response.locals.isAdminAuthenticated) {
        response.status(401).json({ error: "admin authentication required" });
        return;
      }

      const settings = await getAiProviderSettings();
      const rerankerHealth = settings.rerankerEnabled ? await rerankerService.checkHealth() : null;
      response.json({ ...settings, rerankerHealth });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/ai-provider/models", async (request, response, next) => {
    try {
      if (!response.locals.isAdminAuthenticated) {
        response.status(401).json({ error: "admin authentication required" });
        return;
      }

      const provider = String(request.query.provider ?? "").trim().toLowerCase();
      const baseUrl = String(request.query.baseUrl ?? "").trim();
      const apiKey = typeof request.query.apiKey === "string" ? request.query.apiKey.trim() : "";

      if (provider !== "ollama" && provider !== "openai") {
        response.status(400).json({ error: "provider must be 'ollama' or 'openai'" });
        return;
      }
      if (!baseUrl) {
        response.status(400).json({ error: "baseUrl must not be empty" });
        return;
      }

      let connection: AiProviderConnection;
      if (apiKey) {
        connection = { provider: provider as AiProvider, baseUrl, apiKey };
      } else {
        const stored = await getAiProviderConnection();
        const useStoredKey = stored.provider === provider && stored.baseUrl === baseUrl;
        connection = { provider: provider as AiProvider, baseUrl, apiKey: useStoredKey ? stored.apiKey : null };
      }

      const models = await listAiProviderModels(connection);
      response.json({ models });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/ai-provider/settings", async (request, response, next) => {
    try {
      if (!response.locals.isAdminAuthenticated) {
        response.status(401).json({ error: "admin authentication required" });
        return;
      }

      const body = request.body ?? {};
      const provider = String(body.provider ?? "").trim().toLowerCase();
      if (provider !== "ollama" && provider !== "openai") {
        response.status(400).json({ error: "provider must be 'ollama' or 'openai'" });
        return;
      }

      const baseUrl = String(body.baseUrl ?? "").trim();
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : null;
      const embeddingModel = String(body.embeddingModel ?? "").trim();
      const summaryModel = String(body.summaryModel ?? "").trim();
      const classifierModel = String(body.classifierModel ?? "").trim();

      const current = await getAiProviderSettings();

      let embeddingDimension = current.embeddingDimension;
      if (embeddingModel !== current.embeddingModel || provider !== current.provider || baseUrl !== current.baseUrl) {
        const trimmedApiKey = apiKey && apiKey.trim() ? apiKey.trim() : null;
        const sameConnectionAsStored = provider === current.provider && baseUrl === current.baseUrl;
        const effectiveApiKey = trimmedApiKey ?? (sameConnectionAsStored ? (await getAiProviderConnection()).apiKey ?? null : null);
        const connectionForProbe: AiProviderConnection = { provider: provider as AiProvider, baseUrl, apiKey: effectiveApiKey };

        const vectorService = new VectorService();
        const probedDimension = await vectorService.probeEmbeddingDimension(connectionForProbe, embeddingModel);

        if (embeddingModel !== current.embeddingModel && probedDimension !== current.embeddingDimension) {
          response.status(409).json({
            error: `Modell "${embeddingModel}" liefert Embeddings der Dimension ${probedDimension}, gespeichert sind jedoch Chunks mit Dimension ${current.embeddingDimension}. Ein Modellwechsel mit anderer Dimension erfordert eine manuelle Schema-Migration (ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(n)) und ein vollständiges Re-Embedding aller Dokumente.`
          });
          return;
        }

        embeddingDimension = probedDimension;
      }

      // Reranker fields are optional in the payload: an older client that does
      // not know about them keeps whatever is stored instead of clearing it.
      const rerankerEnabled = body.rerankerEnabled === undefined
        ? current.rerankerEnabled
        : body.rerankerEnabled === true || body.rerankerEnabled === "true";
      const rerankerBaseUrl = body.rerankerBaseUrl === undefined
        ? current.rerankerBaseUrl
        : String(body.rerankerBaseUrl ?? "").trim() || null;
      const rerankerModel = body.rerankerModel === undefined
        ? current.rerankerModel
        : String(body.rerankerModel ?? "").trim() || null;
      const rerankerTopN = body.rerankerTopN === undefined
        ? current.rerankerTopN
        : Number(body.rerankerTopN);

      const input: UpdateAiProviderSettingsInput = {
        provider: provider as AiProvider,
        baseUrl,
        apiKey,
        embeddingModel,
        summaryModel,
        classifierModel,
        embeddingDimension,
        rerankerEnabled,
        rerankerBaseUrl,
        rerankerModel,
        rerankerTopN,
        clearApiKey: body.clearApiKey === true || body.clearApiKey === "true"
      };

      const updated = await updateAiProviderSettings(input);
      const rerankerHealth = updated.rerankerEnabled ? await rerankerService.checkHealth() : null;
      response.json({ ...updated, rerankerHealth });
    } catch (error) {
      if (error instanceof Error && /must not be empty|must be a positive number|reranker base URL and model are required/.test(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.get("/admin/mcp-principals", async (_request, response, next) => {
    try {
      response.json(await listMcpPrincipals());
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/mcp-principals", async (request, response, next) => {
    try {
      const payload = await createMcpPrincipal({
        name: String(request.body.name ?? ""),
        description: typeof request.body.description === "string" ? request.body.description : undefined,
        isEnabled: request.body.isEnabled === undefined ? true : Boolean(request.body.isEnabled),
        knowledgeBaseIds: Array.isArray(request.body.knowledgeBaseIds)
          ? request.body.knowledgeBaseIds.map((value: unknown) => Number(value)).filter((value: number) => Number.isFinite(value) && value > 0)
          : []
      });

      response.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/mcp-principals/:id", async (request, response, next) => {
    try {
      const principalId = Number(request.params.id);
      if (!Number.isFinite(principalId) || principalId <= 0) {
        response.status(400).json({ error: "principal id must be a positive number" });
        return;
      }

      const principal = await updateMcpPrincipal(principalId, {
        name: String(request.body.name ?? ""),
        description: typeof request.body.description === "string" ? request.body.description : undefined,
        isEnabled: request.body.isEnabled === undefined ? true : Boolean(request.body.isEnabled),
        knowledgeBaseIds: Array.isArray(request.body.knowledgeBaseIds)
          ? request.body.knowledgeBaseIds.map((value: unknown) => Number(value)).filter((value: number) => Number.isFinite(value) && value > 0)
          : []
      });

      if (!principal) {
        response.status(404).json({ error: "principal not found" });
        return;
      }

      response.json(principal);
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/mcp-principals/:id/rotate-token", async (request, response, next) => {
    try {
      const principalId = Number(request.params.id);
      if (!Number.isFinite(principalId) || principalId <= 0) {
        response.status(400).json({ error: "principal id must be a positive number" });
        return;
      }

      const payload = await rotateMcpPrincipalToken(principalId);
      if (!payload) {
        response.status(404).json({ error: "principal not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/mcp-principals/:id", async (request, response, next) => {
    try {
      const principalId = Number(request.params.id);
      if (!Number.isFinite(principalId) || principalId <= 0) {
        response.status(400).json({ error: "principal id must be a positive number" });
        return;
      }

      const deleted = await deleteMcpPrincipal(principalId);
      if (!deleted) {
        response.status(404).json({ error: "principal not found" });
        return;
      }

      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/upload", upload.single("file"), async (request, response, next) => {
    try {
      if (!request.file) {
        response.status(400).json({ error: "file is required" });
        return;
      }

      const filePath = path.join(env.UPLOAD_DIR, request.file.filename);
      const knowledgeBaseId = parseKnowledgeBaseId(request.body.knowledgeBaseId);
      const job = await ingestQueue.add("ingest", {
        filePath,
        sourceType: "upload",
        sourceRef: request.file.originalname,
        knowledgeBaseId,
        metadata: {
          uploadedFileName: request.file.originalname,
          storedFileName: request.file.filename
        }
      });

      response.status(202).json({ jobId: job.id, file: request.file.originalname });
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/crawl", async (request, response, next) => {
    try {
      const startUrl = String(request.body.startUrl ?? "").trim();
      if (!startUrl) {
        response.status(400).json({ error: "startUrl is required" });
        return;
      }

      const maxDepth = Number(request.body.maxDepth ?? env.CRAWL_DEFAULT_MAX_DEPTH);
      const knowledgeBaseId = parseKnowledgeBaseId(request.body.knowledgeBaseId);
      // Fehlt das Feld, bleibt es beim bisherigen Verhalten: Dokumente ja.
      // Bilder sind neu und standardmaessig aus, weil jedes davon durch OCR geht.
      const downloadDocuments = request.body.downloadDocuments === undefined
        ? true
        : request.body.downloadDocuments === true || request.body.downloadDocuments === "true";
      const downloadImages = request.body.downloadImages === true || request.body.downloadImages === "true";

      const job = await crawlQueue.add("crawl", { startUrl, maxDepth, knowledgeBaseId, downloadDocuments, downloadImages });
      response.status(202).json({ jobId: job.id, startUrl, maxDepth, knowledgeBaseId, downloadDocuments, downloadImages });
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/sync", async (request, response, next) => {
    try {
      const rootDir = typeof request.body.rootDir === "string" && request.body.rootDir.trim()
        ? request.body.rootDir.trim()
        : env.IMPORT_DIR;
      const knowledgeBaseId = parseKnowledgeBaseId(request.body.knowledgeBaseId);
      const job = await syncQueue.add("sync", { rootDir, knowledgeBaseId });
      // Without an explicit knowledge base the worker maps every immediate
      // subdirectory of `rootDir` to one knowledge base (see DirectorySyncService).
      const mode = knowledgeBaseId || !env.SYNC_KNOWLEDGE_BASE_SUBDIRS
        ? "single-knowledge-base"
        : "per-knowledge-base";
      response.status(202).json({ jobId: job.id, rootDir, knowledgeBaseId, mode });
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/git-sync", async (request, response, next) => {
    try {
      const repositoryUrl = String(request.body.repositoryUrl ?? "").trim();
      if (!repositoryUrl) {
        response.status(400).json({ error: "repositoryUrl is required" });
        return;
      }

      const branch = typeof request.body.branch === "string" && request.body.branch.trim()
        ? request.body.branch.trim()
        : null;
      const subPath = typeof request.body.subPath === "string" && request.body.subPath.trim()
        ? request.body.subPath.trim()
        : null;
      const knowledgeBaseId = parseKnowledgeBaseId(request.body.knowledgeBaseId);
      const job = await gitRepoSyncQueue.add("git-sync", { repositoryUrl, branch, subPath, knowledgeBaseId });
      response.status(202).json({ jobId: job.id, repositoryUrl, branch, subPath, knowledgeBaseId });
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs", async (_request, response, next) => {
    try {
      const [crawlJobs, syncJobs, ingestJobs, gitRepoJobs] = await Promise.all([
        crawlQueue.getJobs(["active", "waiting", "completed", "failed"], 0, 20, true),
        syncQueue.getJobs(["active", "waiting", "completed", "failed"], 0, 20, true),
        ingestQueue.getJobs(["active", "waiting", "completed", "failed"], 0, 20, true),
        gitRepoSyncQueue.getJobs(["active", "waiting", "completed", "failed"], 0, 20, true)
      ]);

      response.json(
        [...crawlJobs, ...syncJobs, ...ingestJobs, ...gitRepoJobs]
          .sort((left, right) => Number(right.timestamp) - Number(left.timestamp))
          .map((job) => ({
            id: job.id,
            name: job.name,
            queue: job.queueName,
            state: job.finishedOn ? "completed" : job.failedReason ? "failed" : job.processedOn ? "active" : "waiting",
            data: job.data,
            result: job.returnvalue ?? null,
            failedReason: job.failedReason,
            stacktrace: Array.isArray(job.stacktrace) ? job.stacktrace : [],
            timestamp: job.timestamp,
            finishedOn: job.finishedOn ?? null
          }))
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const limit = Math.min(Math.max(Number(request.query.limit ?? 25), 1), 200);
      const rawQuery = typeof request.query.query === "string" ? request.query.query.trim().toLowerCase() : "";
      const category = typeof request.query.category === "string" ? request.query.category.trim().toLowerCase() : "";
      const sourceType = typeof request.query.sourceType === "string" ? request.query.sourceType.trim().toLowerCase() : "";
      const documentTypeFilter = typeof request.query.documentType === "string" ? request.query.documentType.trim().toLowerCase() : "";
      const sqlLimit = documentTypeFilter ? Math.min(limit * 4, 400) : limit;
      const result = await pool.query<{
        id: number;
        title: string | null;
        source_type: string;
        source_ref: string;
        file_type: string | null;
        created_at: string;
        updated_at: string;
        metadata: Record<string, unknown> | null;
        preview: string | null;
        text_length: number;
      }>(
        `
          SELECT id, title, source_type, source_ref, file_type, created_at, updated_at, metadata,
                 LEFT(COALESCE(extracted_text, ''), 320) AS preview,
                 LENGTH(COALESCE(extracted_text, '')) AS text_length
          FROM documents
          WHERE (
              $5::bigint[] IS NULL
              OR (cardinality($5::bigint[]) > 0 AND knowledge_base_id = ANY($5::bigint[]))
            )
            AND ($1 = '' OR source_type = $1)
            AND (
              $2 = ''
              OR lower(COALESCE(title, '')) LIKE $3
              OR lower(source_ref) LIKE $3
              OR lower(COALESCE(metadata->>'uploadedFileName', '')) LIKE $3
            )
          ORDER BY created_at DESC
          LIMIT $4
        `,
        [sourceType, rawQuery, `%${rawQuery}%`, sqlLimit, allowedKnowledgeBaseIds ?? null]
      );
      const files = await getDocumentFilesByDocumentIds(result.rows.map((row) => Number(row.id)));
      const payload = result.rows.map((row) => {
        const documentType = inferDocumentType({
          title: row.title,
          sourceRef: row.source_ref,
          sourceType: row.source_type,
          fileType: row.file_type,
          metadata: row.metadata ?? {}
        });
        return {
          ...row,
          document_type: documentType,
          original_file: files.get(Number(row.id)) ?? null
        };
      });

      response.json(
        payload
          .filter((row) => !category || matchesCategory({
            chunkId: 0,
            documentId: Number(row.id),
            title: row.title,
            sourceType: row.source_type,
            sourceRef: row.source_ref,
            sourceUrl: null,
            content: row.preview ?? "",
            score: 0,
            vectorScore: 0,
            keywordScore: 0,
            documentMatchScore: 0,
            exactMatch: false,
            metadata: row.metadata ?? {},
            documentType: row.document_type
          }, category))
          .filter((row) => !documentTypeFilter || row.document_type.toLowerCase() === documentTypeFilter)
          .slice(0, limit)
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete("/documents/:id", async (request, response, next) => {
    try {
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const result = await pool.query<{ id: number; title: string | null; source_ref: string }>(
        `
          DELETE FROM documents
          WHERE id = $1
          RETURNING id, title, source_ref
        `,
        [documentId]
      );

      const deleted = result.rows[0];
      if (!deleted) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      try {
        await deleteStoredDocumentAssets(documentId);
      } catch (cleanupError) {
        logger.warn({ error: cleanupError, documentId }, "failed to clean up stored document assets after deletion");
      }

      if (searchIndexService.isEnabled()) {
        try {
          await searchIndexService.deleteDocument(documentId);
        } catch (searchIndexError) {
          logger.warn({ error: searchIndexError, documentId }, "failed to delete document from elasticsearch index");
        }
      }

      response.json({
        ok: true,
        deleted: {
          id: deleted.id,
          title: deleted.title,
          sourceRef: deleted.source_ref
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const fulltext = await executeDocumentFulltextQuery({
        documentId,
        maxChars: Number(request.query.maxChars ?? 12000),
        allowedKnowledgeBaseIds
      });

      if (!fulltext) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      const sections = await executeDocumentSectionsQuery({ documentId, limit: 12, allowedKnowledgeBaseIds });
      const original = await executeDocumentOriginalQuery({ documentId, allowedKnowledgeBaseIds });
      const structure = await executeDocumentStructureQuery({ documentId, limit: 100, allowedKnowledgeBaseIds });
      response.json({
        ...fulltext,
        sections: sections?.sections ?? [],
        structure: structure?.nodes ?? [],
        originalFile: original?.originalFile ?? null,
        documentType: inferDocumentType(fulltext.document),
        classification: (fulltext.document.metadata?.classification as Record<string, unknown> | undefined) ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/documents/:id/reclassify", async (request, response, next) => {
    try {
      if (!response.locals.isAdminAuthenticated) {
        response.status(401).json({ error: "admin authentication required" });
        return;
      }

      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const result = await documentClassificationService.reclassifyDocument(documentId);
      if (!result) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json({
        ok: true,
        documentId: result.documentId,
        documentType: typeof result.metadata.documentType === "string" ? result.metadata.documentType : null,
        classification: (result.metadata.classification as Record<string, unknown> | undefined) ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/fulltext", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeDocumentFulltextQuery({
        documentId,
        maxChars: Number(request.query.maxChars ?? 40000),
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/sections", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeDocumentSectionsQuery({
        documentId,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        limit: Number(request.query.limit ?? 20),
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/structure", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeDocumentStructureQuery({
        documentId,
        limit: Number(request.query.limit ?? 100),
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/original/meta", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeDocumentOriginalQuery({ documentId, allowedKnowledgeBaseIds });
      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/original", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeDocumentOriginalQuery({ documentId, allowedKnowledgeBaseIds });
      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      const localPath = await resolveDocumentLocalFilePath(documentId);
      if (localPath) {
        const downloadName = payload.originalFile?.originalName;
        if (downloadName) {
          response.download(localPath, downloadName);
          return;
        }

        response.download(localPath);
        return;
      }

      if (payload.originalFile?.externalUrl) {
        response.redirect(payload.originalFile.externalUrl);
        return;
      }

      response.status(404).json({ error: "no original document available" });
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/section", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeSingleDocumentSectionQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document section not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/actions", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeMeetingActionsQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/decisions", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeDecisionsQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/deadlines", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeDeadlinesQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/requirements", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeRequirementsQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/config-keys", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeConfigKeysQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/setup-steps", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeSetupStepsQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/api-surface", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeApiSurfaceQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/operational-notes", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeOperationalNotesQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/risks", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeRisksQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/analysis/entities", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeEntitiesQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/summary", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeDocumentSummaryQuery({
        documentId,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/section-summary", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeSectionSummaryQuery({
        documentId,
        sectionIndex: request.query.sectionIndex !== undefined ? Number(request.query.sectionIndex) : undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document section not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/compare", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const leftDocumentId = Number(request.params.id);
      const rightDocumentId = Number(request.query.otherDocumentId);
      const rightSourceRef = typeof request.query.otherSourceRef === "string" ? request.query.otherSourceRef : undefined;

      if (!Number.isFinite(leftDocumentId) || leftDocumentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      if ((!Number.isFinite(rightDocumentId) || rightDocumentId <= 0) && !rightSourceRef) {
        response.status(400).json({ error: "otherDocumentId or otherSourceRef is required" });
        return;
      }

      const payload = await executeCompareDocumentsQuery({
        leftDocumentId,
        rightDocumentId: Number.isFinite(rightDocumentId) && rightDocumentId > 0 ? rightDocumentId : undefined,
        rightSourceRef,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "comparison documents not found" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/documents/:id/compare-version", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const documentId = Number(request.params.id);
      const previousDocumentId = Number(request.query.previousDocumentId);
      const previousSourceRef = typeof request.query.previousSourceRef === "string" ? request.query.previousSourceRef : undefined;

      if (!Number.isFinite(documentId) || documentId <= 0) {
        response.status(400).json({ error: "document id must be a positive number" });
        return;
      }

      const payload = await executeCompareDocumentVersionsQuery({
        documentId,
        previousDocumentId: Number.isFinite(previousDocumentId) && previousDocumentId > 0 ? previousDocumentId : undefined,
        previousSourceRef,
        allowedKnowledgeBaseIds
      });

      if (!payload) {
        response.status(404).json({ error: "document version comparison not available" });
        return;
      }

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/cross-reference", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const topic = String(request.body.topic ?? "").trim();
      if (!topic) {
        response.status(400).json({ error: "topic is required" });
        return;
      }

      const payload = await executeCrossReferenceQuery({
        topic,
        limit: Number(request.body.limit ?? 12),
        allowedKnowledgeBaseIds
      });

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/schedules", async (_request, response, next) => {
    try {
      const result = await pool.query(
        `
          SELECT id, job_type, cron_expression, payload, enabled, created_at
          FROM scheduled_jobs
          ORDER BY created_at DESC
        `
      );
      response.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  router.post("/schedules", async (request, response, next) => {
    try {
      const jobType = String(request.body.jobType ?? "").trim();
      const cronExpression = String(request.body.cronExpression ?? "").trim();
      const payload = request.body.payload && typeof request.body.payload === "object" ? request.body.payload : {};

      if (!["crawl", "sync", "git-sync"].includes(jobType)) {
        response.status(400).json({ error: "jobType must be crawl, sync or git-sync" });
        return;
      }

      const inserted = await pool.query(
        `
          INSERT INTO scheduled_jobs (job_type, cron_expression, payload)
          VALUES ($1, $2, $3::jsonb)
          RETURNING id, job_type, cron_expression, payload, enabled, created_at
        `,
        [jobType, cronExpression, JSON.stringify(payload)]
      );

      await schedulerService.reload();
      response.status(201).json(inserted.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  router.post("/smart-search", async (request, response, next) => {
    try {
      const allowedKnowledgeBaseIds = getAllowedKnowledgeBaseIds(response);
      const query = String(request.body.query ?? "").trim();
      if (!query) {
        response.status(400).json({ error: "query is required" });
        return;
      }

      const payload = await executeSmartSearchQuery({
        query,
        topK: normalizeTopK(request.body.topK ?? env.QUERY_TOP_K),
        model: typeof request.body.model === "string" && request.body.model.trim()
          ? request.body.model.trim()
          : await getEmbeddingModelName(),
        category: typeof request.body.category === "string" ? request.body.category : undefined,
        documentType: typeof request.body.documentType === "string" ? request.body.documentType : undefined,
        sourceTypes: Array.isArray(request.body.sourceTypes) ? request.body.sourceTypes.filter((value: unknown): value is string => typeof value === "string") : undefined,
        fileTypes: Array.isArray(request.body.fileTypes) ? request.body.fileTypes.filter((value: unknown): value is string => typeof value === "string") : undefined,
        allowedKnowledgeBaseIds
      });

      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
