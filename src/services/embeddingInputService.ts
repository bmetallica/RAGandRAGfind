import { env } from "../config/env";

// Bumped whenever the text that goes INTO the embedding model changes shape.
// `document_chunks.embedding_input_version` records which version a stored
// vector was produced with, so a re-embedding run can find the stale ones even
// when the model name did not change (see ReembeddingService's `force` mode).
//
//   1 = raw chunk content, no prefix (everything ingested before this service)
//   2 = document/section context header + model-specific task prefix
export const EMBEDDING_INPUT_VERSION = 2;

export type EmbeddingTask = "document" | "query";

interface TaskPrefixes {
  document: string;
  query: string;
}

// Several embedding models are trained with an asymmetric task prefix and lose
// measurable retrieval quality without it - the document and query vectors end
// up in different parts of the space. There is no way to detect this from the
// API, so it has to be derived from the model name.
function inferTaskPrefixes(model: string): TaskPrefixes {
  const normalized = model.toLowerCase();

  if (normalized.includes("nomic-embed")) {
    return { document: "search_document: ", query: "search_query: " };
  }

  // intfloat/e5 family, including multilingual-e5-*.
  if (/(^|[^a-z])e5([^a-z]|$)/.test(normalized) || normalized.includes("-e5-") || normalized.includes("e5-")) {
    return { document: "passage: ", query: "query: " };
  }

  // mxbai-embed-large prefixes the query side only.
  if (normalized.includes("mxbai-embed")) {
    return { document: "", query: "Represent this sentence for searching relevant passages: " };
  }

  // bge-m3, jina-embeddings-v3, qwen3-embedding and anything unknown: no prefix.
  // Guessing wrong here is worse than not prefixing at all.
  return { document: "", query: "" };
}

export function resolveTaskPrefix(model: string, task: EmbeddingTask): string {
  // Explicit configuration wins, so an exotic model that does not match any
  // name pattern can still be prefixed correctly without a code change.
  const override = task === "document" ? env.EMBEDDING_DOCUMENT_PREFIX : env.EMBEDDING_QUERY_PREFIX;
  if (override) {
    return override;
  }

  return inferTaskPrefixes(model)[task];
}

export function applyEmbeddingTaskPrefix(model: string, task: EmbeddingTask, text: string): string {
  const prefix = resolveTaskPrefix(model, task);
  return prefix ? `${prefix}${text}` : text;
}

const MAX_HEADER_PART_LENGTH = 120;

// Room kept free inside the budget for the task prefix that VectorService adds
// afterwards ("search_document: " and friends are well under this).
const TASK_PREFIX_RESERVE = 32;

// Cuts at the last whitespace before the limit so a truncated input does not end
// mid-word, which would produce a token the model never saw in training.
export function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const slice = text.slice(0, maxLength);
  const lastBreak = slice.lastIndexOf(" ");
  return lastBreak > maxLength * 0.6 ? slice.slice(0, lastBreak) : slice;
}

// Final safety net before a text is sent to the embedding provider. An input
// beyond the server's physical batch size is rejected with a 500 and takes the
// whole batch down with it - see EMBEDDING_MAX_INPUT_CHARS.
export function capEmbeddingInput(text: string): string {
  const budget = env.EMBEDDING_MAX_INPUT_CHARS;
  return budget > 0 ? truncateAtWordBoundary(text, budget) : text;
}

function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

// Prepends the document title and section heading to the chunk before embedding.
// A chunk out of a Dienstplan table or a numbered clause is often meaningless on
// its own - the vector then encodes "a list of names" rather than "the 2017
// Maiausschank roster". The header exists ONLY in the embedding input; it is
// never written back to `document_chunks.content`, so display, full-text search
// and offsets stay exactly as they are.
export function buildDocumentEmbeddingInput(input: {
  documentTitle: string | null;
  sectionTitle: string | null;
  content: string;
}): string {
  const content = input.content;
  const normalizedContent = normalizeForComparison(content);
  const parts: string[] = [];

  for (const candidate of [input.documentTitle, input.sectionTitle]) {
    const trimmed = candidate?.trim();
    if (!trimmed) {
      continue;
    }

    const normalizedCandidate = normalizeForComparison(trimmed);
    // Skip a heading the chunk already repeats verbatim - duplicating it would
    // just weight those tokens twice.
    if (!normalizedCandidate || normalizedContent.includes(normalizedCandidate)) {
      continue;
    }
    if (parts.some((part) => normalizeForComparison(part) === normalizedCandidate)) {
      continue;
    }

    parts.push(truncate(trimmed, MAX_HEADER_PART_LENGTH));
  }

  if (parts.length === 0) {
    return content;
  }

  const withHeader = `${parts.join(" — ")}\n\n${content}`;
  const budget = env.EMBEDDING_MAX_INPUT_CHARS;
  if (budget <= 0 || withHeader.length <= budget - TASK_PREFIX_RESERVE) {
    return withHeader;
  }

  // The header is an enrichment, the chunk is the payload: when both do not fit,
  // drop the header rather than cut content the header was meant to explain.
  return content;
}
