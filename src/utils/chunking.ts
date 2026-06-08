import { decode, encode } from "gpt-tokenizer";
import { countTextTokens } from "../services/tokenizerService";

export interface ChunkResult {
  chunkIndex: number;
  content: string;
  tokenEstimate: number;
  startOffset: number;
  endOffset: number;
}

export interface ChunkingOptions {
  // Measured in tokens (see tokenizerService) - not characters.
  chunkSize: number;
  overlap: number;
}

export function normalizeDocumentText(input: string): string {
  return input.replace(/\u0000/g, "").replace(/\r/g, "").replace(/\t/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function locateChunkOffsets(text: string, chunks: Omit<ChunkResult, "startOffset" | "endOffset">[]): ChunkResult[] {
  let searchStart = 0;

  return chunks.map((chunk) => {
    const normalizedContent = chunk.content.trim();
    // Rewind by the chunk's own content length (not by `overlap`, which may be
    // measured in tokens rather than characters) so the search window always
    // covers the full range an overlapping chunk could plausibly start in.
    const relaxedSearchStart = Math.max(0, searchStart - normalizedContent.length - 32);
    let startOffset = text.indexOf(normalizedContent, relaxedSearchStart);

    if (startOffset < 0) {
      const fallbackNeedle = normalizedContent.slice(0, Math.min(normalizedContent.length, 160));
      startOffset = fallbackNeedle ? text.indexOf(fallbackNeedle, relaxedSearchStart) : -1;
    }

    if (startOffset < 0) {
      startOffset = Math.min(relaxedSearchStart, text.length);
    }

    const endOffset = Math.min(text.length, startOffset + normalizedContent.length);
    searchStart = endOffset;

    return {
      ...chunk,
      startOffset,
      endOffset
    };
  });
}

// Byte-level BPE tokens can represent partial multi-byte UTF-8 sequences, so
// decoding an arbitrary contiguous token slice can land mid-character and
// produce replacement characters (U+FFFD) instead of a clean substring of the
// original text (e.g. cutting `ß` between its two UTF-8 bytes). Shrink the
// slice from the end until it decodes cleanly - this only triggers right at a
// multi-byte character boundary, so at most a token or two are trimmed.
function decodeValidSubstring(tokens: number[], start: number, end: number): string {
  for (let sliceEnd = end; sliceEnd > start; sliceEnd -= 1) {
    const content = decode(tokens.slice(start, sliceEnd)).trim();
    if (content && !content.includes("�")) {
      return content;
    }
  }

  return "";
}

// Same boundary issue as `decodeValidSubstring`, but for a token suffix (used
// to seed the overlap buffer between chunks): drop leading tokens until the
// remainder decodes cleanly, keeping as much of the overlap as possible.
function decodeValidSuffix(tokens: number[]): string {
  for (let sliceStart = 0; sliceStart < tokens.length; sliceStart += 1) {
    const content = decode(tokens.slice(sliceStart)).trim();
    if (content && !content.includes("�")) {
      return content;
    }
  }

  return "";
}

// Splits an oversized paragraph into token-bounded slices. Encoding once and
// slicing the token array (rather than re-encoding growing substrings) keeps
// this linear in the paragraph length.
function splitOversizedParagraph(
  paragraph: string,
  options: ChunkingOptions,
  startIndex: number
): Omit<ChunkResult, "startOffset" | "endOffset">[] {
  const tokens = encode(paragraph);
  const chunks: Omit<ChunkResult, "startOffset" | "endOffset">[] = [];
  let chunkIndex = startIndex;
  let offset = 0;

  while (offset < tokens.length) {
    const sliceEnd = Math.min(tokens.length, offset + options.chunkSize);
    const content = decodeValidSubstring(tokens, offset, sliceEnd);

    if (content) {
      chunks.push({
        chunkIndex,
        content,
        tokenEstimate: countTextTokens(content)
      });
      chunkIndex += 1;
    }

    offset += Math.max(1, options.chunkSize - options.overlap);
  }

  return chunks;
}

export function smartChunkText(input: string, options: ChunkingOptions): ChunkResult[] {
  const text = normalizeDocumentText(input);
  if (!text) {
    return [];
  }

  const paragraphs = text.split(/\n\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: Omit<ChunkResult, "startOffset" | "endOffset">[] = [];
  let buffer = "";
  let chunkIndex = 0;

  const flush = () => {
    const content = buffer.trim();
    if (!content) {
      buffer = "";
      return;
    }

    const tokenEstimate = countTextTokens(content);
    chunks.push({
      chunkIndex,
      content,
      tokenEstimate
    });
    chunkIndex += 1;

    const overlapTokens = encode(content).slice(-options.overlap);
    buffer = overlapTokens.length ? decodeValidSuffix(overlapTokens) : "";
  };

  for (const paragraph of paragraphs) {
    const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph;

    if (countTextTokens(next) <= options.chunkSize) {
      buffer = next;
      continue;
    }

    if (buffer) {
      flush();
    }

    if (countTextTokens(paragraph) <= options.chunkSize) {
      buffer = paragraph;
      continue;
    }

    const oversizedChunks = splitOversizedParagraph(paragraph, options, chunkIndex);
    chunks.push(...oversizedChunks);
    chunkIndex += oversizedChunks.length;
    buffer = "";
  }

  if (buffer) {
    flush();
  }

  return locateChunkOffsets(text, chunks);
}
