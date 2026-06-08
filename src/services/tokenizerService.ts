import { countTokens } from "gpt-tokenizer";
import { logger } from "../utils/logger";

let warnedOnFallback = false;

function fallbackEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

// Token counts here approximate the embedding model's actual subword tokenizer
// (nomic-embed-text uses a BERT/WordPiece vocabulary, not OpenAI's BPE encoding
// that gpt-tokenizer implements). It is still far closer to the model's real
// token budget than a flat `length / 4` heuristic - especially for German text
// and code, where the char-to-token ratio swings widely - and avoids pulling in
// a per-model tokenizer loader (and its runtime/dependency weight).
export function countTextTokens(text: string): number {
  try {
    return countTokens(text);
  } catch (error) {
    if (!warnedOnFallback) {
      warnedOnFallback = true;
      logger.warn({ err: error }, "token counting failed, falling back to length-based estimate");
    }

    return fallbackEstimate(text);
  }
}
