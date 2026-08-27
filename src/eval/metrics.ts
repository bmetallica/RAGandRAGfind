// Retrieval metrics with binary relevance: a retrieved document is either one
// of the goldenset's expected documents or it is not. Graded relevance would
// need a per-query relevance scale in the goldenset, which is far more work to
// maintain than it is worth at this corpus size.

export interface RankedRelevance {
  // One entry per retrieved document, in rank order, `true` where the document
  // is one of the expected ones.
  relevantByRank: boolean[];
  // How many distinct documents the goldenset expects for this query.
  expectedCount: number;
}

export interface QueryMetrics {
  recall: number;
  precisionAt1: number;
  mrr: number;
  ndcg: number;
}

export function recallAtK({ relevantByRank, expectedCount }: RankedRelevance, k: number): number {
  if (expectedCount === 0) {
    return 0;
  }

  const found = relevantByRank.slice(0, k).filter(Boolean).length;
  return Math.min(1, found / expectedCount);
}

export function precisionAt1({ relevantByRank }: RankedRelevance): number {
  return relevantByRank[0] ? 1 : 0;
}

// Reciprocal rank of the FIRST relevant document - the metric that best matches
// "did the user have to scroll?".
export function reciprocalRank({ relevantByRank }: RankedRelevance, k: number): number {
  const index = relevantByRank.slice(0, k).findIndex(Boolean);
  return index < 0 ? 0 : 1 / (index + 1);
}

// nDCG@k with binary gains. The ideal ranking puts every expected document in
// the top positions, so the IDCG only depends on min(expectedCount, k).
export function ndcgAtK({ relevantByRank, expectedCount }: RankedRelevance, k: number): number {
  if (expectedCount === 0) {
    return 0;
  }

  let dcg = 0;
  relevantByRank.slice(0, k).forEach((isRelevant, index) => {
    if (isRelevant) {
      dcg += 1 / Math.log2(index + 2);
    }
  });

  let idcg = 0;
  for (let index = 0; index < Math.min(expectedCount, k); index += 1) {
    idcg += 1 / Math.log2(index + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

export function computeQueryMetrics(relevance: RankedRelevance, k: number): QueryMetrics {
  return {
    recall: recallAtK(relevance, k),
    precisionAt1: precisionAt1(relevance),
    mrr: reciprocalRank(relevance, k),
    ndcg: ndcgAtK(relevance, k)
  };
}

export function averageMetrics(entries: QueryMetrics[]): QueryMetrics {
  if (entries.length === 0) {
    return { recall: 0, precisionAt1: 0, mrr: 0, ndcg: 0 };
  }

  const sum = entries.reduce(
    (total, entry) => ({
      recall: total.recall + entry.recall,
      precisionAt1: total.precisionAt1 + entry.precisionAt1,
      mrr: total.mrr + entry.mrr,
      ndcg: total.ndcg + entry.ndcg
    }),
    { recall: 0, precisionAt1: 0, mrr: 0, ndcg: 0 }
  );

  return {
    recall: sum.recall / entries.length,
    precisionAt1: sum.precisionAt1 / entries.length,
    mrr: sum.mrr / entries.length,
    ndcg: sum.ndcg / entries.length
  };
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}
