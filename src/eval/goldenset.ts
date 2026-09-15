import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_GOLDENSET_PATH = "eval/goldenset.json";

const goldensetQuerySchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  // Slug of the knowledge base to search in. Omit to search across everything
  // the query path would see without an ACL restriction.
  knowledgeBase: z.string().min(1).optional(),
  // Substrings matched case-insensitively against a hit's `sourceRef` or
  // `title`. A file name is usually the most stable identifier; a document id
  // would break as soon as the corpus is re-ingested.
  expectedDocuments: z.array(z.string().min(1)).min(1),
  // Optional stricter check: text that must show up in the retrieved chunks,
  // so a run that returns the right document but the wrong section is visible.
  expectedSnippets: z.array(z.string().min(1)).default([]),
  note: z.string().optional()
});

const goldensetSchema = z.object({
  // Defaults applied to every query in this file; a query never overrides topK,
  // because comparing runs at different k is meaningless.
  topK: z.number().int().positive().default(10),
  queries: z.array(goldensetQuerySchema).min(1)
});

export type GoldensetQuery = z.infer<typeof goldensetQuerySchema>;
export type Goldenset = z.infer<typeof goldensetSchema>;

export async function loadGoldenset(filePath: string): Promise<Goldenset> {
  const absolutePath = path.resolve(filePath);

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not read goldenset at ${absolutePath}: ${reason}\n`
        + `Run "npm run eval:bootstrap" to generate a template from the documents already in the database.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`goldenset at ${absolutePath} is not valid JSON: ${reason}`);
  }

  const result = goldensetSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`goldenset at ${absolutePath} is invalid:\n${issues}`);
  }

  const duplicateIds = result.data.queries
    .map((entry) => entry.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`goldenset contains duplicate query ids: ${[...new Set(duplicateIds)].join(", ")}`);
  }

  return result.data;
}

function normalizeForMatching(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// A hit counts for an expected document when the expectation appears in its
// source ref or title. Substring matching keeps the goldenset readable
// ("Dienstplan_17") and survives a re-ingestion that changes document ids.
export function matchesExpectedDocument(
  hit: { sourceRef: string; title: string | null },
  expected: string
): boolean {
  const needle = normalizeForMatching(expected);
  return (
    normalizeForMatching(hit.sourceRef).includes(needle)
    || normalizeForMatching(hit.title ?? "").includes(needle)
  );
}

export function countMatchedSnippets(contents: string[], snippets: string[]): number {
  if (snippets.length === 0) {
    return 0;
  }

  const haystack = normalizeForMatching(contents.join("\n"));
  return snippets.filter((snippet) => haystack.includes(normalizeForMatching(snippet))).length;
}
