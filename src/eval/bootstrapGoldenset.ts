import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/pool";

const DEFAULT_OUTPUT_PATH = "eval/goldenset.template.json";
const DEFAULT_SAMPLE_SIZE = 40;

interface SampleRow {
  source_ref: string;
  title: string | null;
  document_type: string | null;
  knowledge_base_slug: string | null;
}

function slugifyId(sourceRef: string, index: number): string {
  const base = path
    .basename(sourceRef, path.extname(sourceRef))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return base ? `${base}-${index + 1}` : `query-${index + 1}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputPath = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_OUTPUT_PATH;
  const sizeArg = args.find((arg) => arg.startsWith("--size="));
  const sampleSize = sizeArg ? Number(sizeArg.slice("--size=".length)) : DEFAULT_SAMPLE_SIZE;

  if (!Number.isFinite(sampleSize) || sampleSize < 1) {
    throw new Error("--size must be a positive number");
  }

  // Spread the sample over document types and knowledge bases instead of taking
  // the newest N - a goldenset built only from invoices says nothing about how
  // the system handles manuals.
  const result = await pool.query<SampleRow>(
    `
      WITH ranked AS (
        SELECT
          d.source_ref,
          d.title,
          d.metadata->>'documentType' AS document_type,
          kb.slug AS knowledge_base_slug,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(kb.slug, ''), COALESCE(d.metadata->>'documentType', 'generic')
            ORDER BY d.id DESC
          ) AS type_rank
        FROM documents d
        LEFT JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
      )
      SELECT source_ref, title, document_type, knowledge_base_slug
      FROM ranked
      ORDER BY type_rank ASC, knowledge_base_slug ASC NULLS LAST, source_ref ASC
      LIMIT $1
    `,
    [sampleSize]
  );

  if (result.rows.length === 0) {
    throw new Error("no documents in the database - ingest something before bootstrapping a goldenset");
  }

  const template = {
    topK: 10,
    queries: result.rows.map((row, index) => ({
      id: slugifyId(row.source_ref, index),
      // Intentionally empty: only a human knows what someone would actually ask
      // about this document. An LLM-generated question tests whether retrieval
      // can find the document it was generated from, which is close to circular.
      query: "",
      ...(row.knowledge_base_slug ? { knowledgeBase: row.knowledge_base_slug } : {}),
      expectedDocuments: [path.basename(row.source_ref)],
      expectedSnippets: [],
      note: `${row.document_type ?? "generic"} · ${row.title ?? "(ohne Titel)"}`
    }))
  };

  const absolutePath = path.resolve(outputPath);
  await writeFile(absolutePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

  process.stdout.write(
    [
      `Template mit ${template.queries.length} Einträgen geschrieben: ${absolutePath}`,
      "",
      'Nächster Schritt: pro Eintrag das leere Feld "query" mit einer echten Frage füllen,',
      "Einträge ohne sinnvolle Frage löschen, und die Datei nach eval/goldenset.json umbenennen.",
      'Einträge mit leerem "query" werden von "npm run eval" als ungültig abgelehnt.',
      ""
    ].join("\n")
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
