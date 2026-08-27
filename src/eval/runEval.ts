import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/pool";
import { executeSmartSearchQuery } from "../routes/api";
import { getEmbeddingModelName } from "../services/aiProviderSettingsService";
import {
  DEFAULT_GOLDENSET_PATH,
  countMatchedSnippets,
  loadGoldenset,
  matchesExpectedDocument,
  type GoldensetQuery
} from "./goldenset";
import { averageMetrics, computeQueryMetrics, percentile, type QueryMetrics } from "./metrics";

const DEFAULT_RESULTS_DIR = "eval/results";

interface CliOptions {
  goldensetPath: string;
  tag: string | null;
  baselinePath: string | null;
  filter: string | null;
  topKOverride: number | null;
}

interface QueryReport {
  id: string;
  query: string;
  knowledgeBase: string | null;
  metrics: QueryMetrics;
  latencyMs: number;
  expectedDocuments: string[];
  retrievedDocuments: string[];
  firstRelevantRank: number | null;
  snippetHits: number;
  snippetTotal: number;
  error: string | null;
}

interface EvalReport {
  tag: string | null;
  startedAt: string;
  goldensetPath: string;
  embeddingModel: string;
  topK: number;
  queryCount: number;
  failedCount: number;
  aggregate: QueryMetrics & {
    snippetRecall: number;
    latencyMsMean: number;
    latencyMsP50: number;
    latencyMsP95: number;
  };
  queries: QueryReport[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    goldensetPath: DEFAULT_GOLDENSET_PATH,
    tag: null,
    baselinePath: null,
    filter: null,
    topKOverride: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // Accept both "--flag value" and "--flag=value".
    const [flag, inlineValue] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const readValue = (): string => {
      if (inlineValue !== null) {
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`missing value for ${flag}`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--goldenset":
        options.goldensetPath = readValue();
        break;
      case "--tag":
        options.tag = readValue();
        break;
      case "--baseline":
        options.baselinePath = readValue();
        break;
      case "--filter":
        options.filter = readValue();
        break;
      case "--top-k":
        options.topKOverride = Number(readValue());
        break;
      case "--help":
        printUsage();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.topKOverride !== null && (!Number.isFinite(options.topKOverride) || options.topKOverride < 1)) {
    throw new Error("--top-k must be a positive number");
  }

  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: npm run eval -- [options]",
      "",
      "  --goldenset <path>   Goldenset file (default: eval/goldenset.json)",
      "  --tag <name>         Write the report to eval/results/<name>.json",
      "  --baseline <path>    Compare against an earlier report and show per-query deltas",
      "  --filter <substring> Only run queries whose id contains this substring",
      "  --top-k <n>          Override the goldenset's topK (changes what is comparable!)",
      ""
    ].join("\n")
  );
}

async function resolveKnowledgeBaseIds(slugs: string[]): Promise<Map<string, number>> {
  if (slugs.length === 0) {
    return new Map();
  }

  const result = await pool.query<{ id: number; slug: string }>(
    "SELECT id, slug FROM knowledge_bases WHERE slug = ANY($1::text[])",
    [slugs]
  );

  const resolved = new Map(result.rows.map((row) => [row.slug, row.id]));
  const missing = slugs.filter((slug) => !resolved.has(slug));
  if (missing.length > 0) {
    throw new Error(`goldenset references unknown knowledge base slugs: ${missing.join(", ")}`);
  }

  return resolved;
}

async function runQuery(
  entry: GoldensetQuery,
  topK: number,
  model: string,
  knowledgeBaseIds: Map<string, number>
): Promise<QueryReport> {
  const allowedKnowledgeBaseIds = entry.knowledgeBase
    ? [knowledgeBaseIds.get(entry.knowledgeBase) as number]
    : undefined;

  const startedAt = Date.now();
  let items: Awaited<ReturnType<typeof executeSmartSearchQuery>>["items"] = [];
  let error: string | null = null;

  try {
    const response = await executeSmartSearchQuery({
      query: entry.query,
      topK,
      model,
      allowedKnowledgeBaseIds
    });
    items = response.items;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const latencyMs = Date.now() - startedAt;

  // Metrics are document-level: several chunks of the same document occupy one
  // rank, otherwise a document that contributes three chunks would inflate
  // precision without telling the user anything new.
  const rankedDocuments: Array<{ documentId: number; sourceRef: string; title: string | null }> = [];
  const seenDocumentIds = new Set<number>();
  for (const item of items) {
    if (seenDocumentIds.has(item.documentId)) {
      continue;
    }
    seenDocumentIds.add(item.documentId);
    rankedDocuments.push({ documentId: item.documentId, sourceRef: item.sourceRef, title: item.title });
  }

  // An expected document counts as found once, no matter how many hits match
  // it, so recall cannot exceed 1 when two hits match the same expectation.
  const matchedExpectations = new Set<string>();
  const relevantByRank = rankedDocuments.map((document) => {
    const matched = entry.expectedDocuments.filter((expected) => matchesExpectedDocument(document, expected));
    const isNew = matched.some((expected) => !matchedExpectations.has(expected));
    matched.forEach((expected) => matchedExpectations.add(expected));
    return isNew;
  });

  const relevance = { relevantByRank, expectedCount: entry.expectedDocuments.length };
  const firstRelevantIndex = relevantByRank.findIndex(Boolean);

  return {
    id: entry.id,
    query: entry.query,
    knowledgeBase: entry.knowledgeBase ?? null,
    metrics: computeQueryMetrics(relevance, topK),
    latencyMs,
    expectedDocuments: entry.expectedDocuments,
    retrievedDocuments: rankedDocuments.map((document) => document.sourceRef),
    firstRelevantRank: firstRelevantIndex < 0 ? null : firstRelevantIndex + 1,
    snippetHits: countMatchedSnippets(items.map((item) => item.content), entry.expectedSnippets),
    snippetTotal: entry.expectedSnippets.length,
    error
  };
}

function formatMetric(value: number): string {
  return value.toFixed(3);
}

function printReport(report: EvalReport): void {
  const idWidth = Math.max(8, ...report.queries.map((entry) => entry.id.length));
  const lines: string[] = [];

  lines.push("");
  lines.push(
    `${"query".padEnd(idWidth)}  ${"recall".padStart(6)}  ${"mrr".padStart(6)}  ${"ndcg".padStart(6)}  ${"p@1".padStart(4)}  ${"rank".padStart(4)}  ${"ms".padStart(6)}`
  );
  lines.push("-".repeat(idWidth + 40));

  for (const entry of report.queries) {
    if (entry.error) {
      lines.push(`${entry.id.padEnd(idWidth)}  FEHLER: ${entry.error}`);
      continue;
    }

    lines.push(
      [
        entry.id.padEnd(idWidth),
        formatMetric(entry.metrics.recall).padStart(6),
        formatMetric(entry.metrics.mrr).padStart(6),
        formatMetric(entry.metrics.ndcg).padStart(6),
        String(entry.metrics.precisionAt1).padStart(4),
        (entry.firstRelevantRank === null ? "-" : String(entry.firstRelevantRank)).padStart(4),
        String(entry.latencyMs).padStart(6)
      ].join("  ")
    );
  }

  lines.push("-".repeat(idWidth + 40));
  lines.push(
    [
      "MITTEL".padEnd(idWidth),
      formatMetric(report.aggregate.recall).padStart(6),
      formatMetric(report.aggregate.mrr).padStart(6),
      formatMetric(report.aggregate.ndcg).padStart(6),
      formatMetric(report.aggregate.precisionAt1).padStart(4),
      "".padStart(4),
      String(Math.round(report.aggregate.latencyMsMean)).padStart(6)
    ].join("  ")
  );
  lines.push("");
  lines.push(
    `Latenz p50 ${Math.round(report.aggregate.latencyMsP50)} ms · p95 ${Math.round(report.aggregate.latencyMsP95)} ms · Modell ${report.embeddingModel} · topK ${report.topK}`
  );

  const snippetTotal = report.queries.reduce((total, entry) => total + entry.snippetTotal, 0);
  if (snippetTotal > 0) {
    lines.push(`Snippet-Recall ${formatMetric(report.aggregate.snippetRecall)} (${snippetTotal} erwartete Snippets)`);
  }

  const misses = report.queries.filter((entry) => !entry.error && entry.metrics.recall === 0);
  if (misses.length > 0) {
    lines.push("");
    lines.push(`Totalausfälle (kein erwartetes Dokument in den Top ${report.topK}):`);
    for (const entry of misses) {
      lines.push(`  ${entry.id}: erwartet ${entry.expectedDocuments.join(", ")}`);
      lines.push(`    gefunden: ${entry.retrievedDocuments.slice(0, 3).join(", ") || "(nichts)"}`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function printBaselineComparison(report: EvalReport, baselinePath: string): Promise<void> {
  const raw = await readFile(path.resolve(baselinePath), "utf8");
  const baseline = JSON.parse(raw) as EvalReport;

  if (baseline.topK !== report.topK) {
    process.stdout.write(
      `\nWARNUNG: Baseline lief mit topK ${baseline.topK}, dieser Lauf mit ${report.topK} - die Werte sind nicht vergleichbar.\n`
    );
  }

  const baselineById = new Map(baseline.queries.map((entry) => [entry.id, entry]));
  const improved: string[] = [];
  const regressed: string[] = [];

  for (const entry of report.queries) {
    const previous = baselineById.get(entry.id);
    if (!previous || entry.error || previous.error) {
      continue;
    }

    const delta = entry.metrics.ndcg - previous.metrics.ndcg;
    if (delta > 0.01) {
      improved.push(`  ${entry.id}: ${formatMetric(previous.metrics.ndcg)} -> ${formatMetric(entry.metrics.ndcg)}`);
    } else if (delta < -0.01) {
      regressed.push(`  ${entry.id}: ${formatMetric(previous.metrics.ndcg)} -> ${formatMetric(entry.metrics.ndcg)}`);
    }
  }

  const lines = ["", `Vergleich gegen ${baselinePath}${baseline.tag ? ` (${baseline.tag})` : ""}:`];
  for (const [label, current, previous] of [
    ["recall", report.aggregate.recall, baseline.aggregate.recall],
    ["mrr", report.aggregate.mrr, baseline.aggregate.mrr],
    ["ndcg", report.aggregate.ndcg, baseline.aggregate.ndcg],
    ["p@1", report.aggregate.precisionAt1, baseline.aggregate.precisionAt1]
  ] as Array<[string, number, number]>) {
    const delta = current - previous;
    const sign = delta >= 0 ? "+" : "";
    lines.push(`  ${label.padEnd(7)} ${formatMetric(previous)} -> ${formatMetric(current)}  (${sign}${delta.toFixed(3)})`);
  }

  if (regressed.length > 0) {
    lines.push("", `Verschlechtert (${regressed.length}):`, ...regressed);
  }
  if (improved.length > 0) {
    lines.push("", `Verbessert (${improved.length}):`, ...improved);
  }
  if (regressed.length === 0 && improved.length === 0) {
    lines.push("", "Keine Query hat sich um mehr als 0.01 nDCG verändert.");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const goldenset = await loadGoldenset(options.goldensetPath);
  const topK = options.topKOverride ?? goldenset.topK;

  const queries = options.filter
    ? goldenset.queries.filter((entry) => entry.id.includes(options.filter as string))
    : goldenset.queries;

  if (queries.length === 0) {
    throw new Error(`no goldenset query matched --filter ${options.filter}`);
  }

  const knowledgeBaseIds = await resolveKnowledgeBaseIds([
    ...new Set(queries.map((entry) => entry.knowledgeBase).filter((slug): slug is string => Boolean(slug)))
  ]);
  const model = await getEmbeddingModelName();

  // Sequential on purpose: the embedding provider is behind a concurrency
  // semaphore anyway, and parallel runs would make the latency numbers useless.
  const reports: QueryReport[] = [];
  for (const entry of queries) {
    process.stderr.write(`[${reports.length + 1}/${queries.length}] ${entry.id}\n`);
    reports.push(await runQuery(entry, topK, model, knowledgeBaseIds));
  }

  const successful = reports.filter((entry) => !entry.error);
  const latencies = successful.map((entry) => entry.latencyMs);
  const snippetTotal = reports.reduce((total, entry) => total + entry.snippetTotal, 0);
  const snippetHits = reports.reduce((total, entry) => total + entry.snippetHits, 0);

  const report: EvalReport = {
    tag: options.tag,
    startedAt: new Date().toISOString(),
    goldensetPath: options.goldensetPath,
    embeddingModel: model,
    topK,
    queryCount: reports.length,
    failedCount: reports.length - successful.length,
    aggregate: {
      ...averageMetrics(successful.map((entry) => entry.metrics)),
      snippetRecall: snippetTotal === 0 ? 0 : snippetHits / snippetTotal,
      latencyMsMean: latencies.length === 0 ? 0 : latencies.reduce((total, value) => total + value, 0) / latencies.length,
      latencyMsP50: percentile(latencies, 0.5),
      latencyMsP95: percentile(latencies, 0.95)
    },
    queries: reports
  };

  printReport(report);

  if (options.tag) {
    const outputPath = path.resolve(DEFAULT_RESULTS_DIR, `${options.tag}.json`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`\nReport geschrieben: ${outputPath}\n`);
  }

  if (options.baselinePath) {
    await printBaselineComparison(report, options.baselinePath);
  }
}

main()
  .then(() => {
    // The imported query path opens a Redis connection and the PG pool, both of
    // which keep the event loop alive - exit explicitly instead of unwinding.
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
