import path from "node:path";
import { access, readFile } from "node:fs/promises";
import hljs from "highlight.js";
import { env } from "../config/env";
import { pool } from "../db/pool";
import type { DocumentRecord } from "../services/documentService";
import type { DocumentFileRecord } from "../services/originalFileService";
import { ensurePdfRendition, isOfficeConvertible, isPdfFile, readPdfPageCount } from "./derivedAssets";

export type PresentationKind =
  | "pdf"
  | "webpage"
  | "image"
  | "audio"
  | "video"
  | "markdown"
  | "code"
  | "text"
  | "binary";

export interface ViewerSection {
  index: number;
  title: string;
  preview: string;
  startOffset: number;
  pageStart: number | null;
}

export interface ViewerPayload {
  documentId: number;
  title: string;
  sourceRef: string;
  sourceType: string;
  sourceUrl: string | null;
  fileType: string | null;
  mimeType: string | null;
  documentType: string | null;
  summary: string | null;
  knowledgeBaseName: string | null;
  createdAt: string;
  updatedAt: string;
  fileSizeBytes: number | null;
  pageCount: number | null;
  presentation: PresentationKind;
  converted: boolean;
  pdfUrl: string | null;
  pageUrl: string | null;
  mediaUrl: string | null;
  originalUrl: string | null;
  downloadUrl: string | null;
  originalName: string | null;
  renderedHtml: string;
  rawText: string;
  sections: ViewerSection[];
  notice: string | null;
  query: string;
  highlight: string;
}

const CODE_FILE_TYPES = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "java", "go", "rs", "rb", "php", "c", "cc", "cpp", "h", "hpp",
  "cs", "sh", "bash", "zsh", "json", "yml", "yaml", "toml", "ini", "cfg", "conf", "xml", "sql", "css", "scss",
  "less", "vue", "svelte", "gradle", "dockerfile", "makefile", "lua", "pl", "r", "swift", "kt"
]);

const IMAGE_FILE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tif", "tiff", "ico", "avif"]);
const AUDIO_FILE_TYPES = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);
const VIDEO_FILE_TYPES = new Set(["mp4", "mkv", "mov", "avi", "webm", "m4v"]);

const HIGHLIGHT_LANGUAGES: Record<string, string> = {
  js: "javascript", jsx: "javascript", cjs: "javascript", mjs: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", rs: "rust",
  go: "go", java: "java", php: "php", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", md: "markdown", json: "json", css: "css",
  scss: "scss", less: "less", html: "xml", htm: "xml", xml: "xml", sql: "sql",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini", lua: "lua", kt: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp"
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextFileIfPresent(filePath: string | null): Promise<string | null> {
  if (!filePath || !(await fileExists(filePath))) {
    return null;
  }

  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export function absoluteFilePath(file: DocumentFileRecord | null): string | null {
  return file?.relativePath ? path.join(env.ORIGINAL_STORAGE_DIR, file.relativePath) : null;
}

export function isWebPageDocument(document: DocumentRecord): boolean {
  if (document.sourceType.startsWith("crawl")) {
    return true;
  }

  const mimeType = document.mimeType?.toLowerCase() ?? "";
  const fileType = document.fileType?.toLowerCase() ?? "";
  return mimeType.includes("html") || ["html", "htm", "xhtml"].includes(fileType);
}

function matchesType(document: DocumentRecord, fileTypes: Set<string>, mimePrefix: string): boolean {
  const fileType = document.fileType?.toLowerCase() ?? "";
  const mimeType = document.mimeType?.toLowerCase() ?? "";
  return fileTypes.has(fileType) || mimeType.startsWith(mimePrefix);
}

function isMarkdownDocument(document: DocumentRecord): boolean {
  const fileType = document.fileType?.toLowerCase() ?? "";
  const mimeType = document.mimeType?.toLowerCase() ?? "";
  return ["md", "markdown", "mdx"].includes(fileType)
    || mimeType.includes("markdown")
    || /\.(md|markdown|mdx)$/i.test(document.sourceRef);
}

function isCodeDocument(document: DocumentRecord): boolean {
  const fileType = document.fileType?.toLowerCase() ?? "";
  if (CODE_FILE_TYPES.has(fileType)) {
    return true;
  }

  // Git-Dateien ohne bekannte Endung (LICENSE, .gitignore, Makefile) sind
  // trotzdem Quelltext und gehoeren in die Code-Ansicht, nicht in den Fliesstext.
  return document.sourceType === "git";
}

export function detectHighlightLanguage(sourceRef: string, fileType: string | null, mimeType: string | null): string | undefined {
  const extension = (fileType || sourceRef.split(".").pop() || "").toLowerCase();
  if (HIGHLIGHT_LANGUAGES[extension]) {
    return HIGHLIGHT_LANGUAGES[extension];
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

interface ViewerExtras {
  knowledgeBaseName: string | null;
  documentType: string | null;
  summary: string | null;
}

async function loadViewerExtras(documentId: number): Promise<ViewerExtras> {
  const result = await pool.query<{
    knowledge_base_name: string | null;
    document_type: string | null;
    summary: string | null;
  }>(
    `
      SELECT
        kb.name AS knowledge_base_name,
        d.metadata->>'documentType' AS document_type,
        d.metadata->'classification'->>'summary' AS summary
      FROM documents d
      LEFT JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
      WHERE d.id = $1
    `,
    [documentId]
  );

  const row = result.rows[0];
  return {
    knowledgeBaseName: row?.knowledge_base_name ?? null,
    documentType: row?.document_type ?? null,
    summary: row?.summary ?? null
  };
}

async function loadSections(documentId: number): Promise<ViewerSection[]> {
  const result = await pool.query<{
    section_index: number;
    title: string | null;
    preview: string | null;
    start_offset: number | null;
    page_start: number | null;
  }>(
    `
      SELECT section_index, title, preview, start_offset, page_start
      FROM document_sections
      WHERE document_id = $1
      ORDER BY section_index ASC
      LIMIT 400
    `,
    [documentId]
  );

  return result.rows
    .map((row) => ({
      index: row.section_index,
      title: (row.title ?? "").trim(),
      preview: (row.preview ?? "").trim(),
      startOffset: Number(row.start_offset ?? 0),
      pageStart: row.page_start === null ? null : Number(row.page_start)
    }))
    // Die Strukturerkennung macht aus jeder kurzen Zeile einen Abschnitt - bei
    // einem Dienstplan also aus jedem Namen. Wo die Vorschau nicht ueber die
    // Ueberschrift hinausgeht, stand dort nichts als die Zeile selbst; als
    // Gliederungspunkt taugt das nicht.
    .filter((section) => section.title.length > 0 && section.preview.length > section.title.length + 10);
}

// Entscheidet, wie ein Dokument am sinnvollsten gezeigt wird, und beschafft
// dabei, was die Ansicht braucht: die PDF-Fassung eines Office-Dokuments, die
// gespeicherte Kopie einer Webseite, den gerenderten Text.
export async function buildViewerPayload(
  document: DocumentRecord,
  file: DocumentFileRecord | null,
  options: { query: string; highlight: string }
): Promise<ViewerPayload> {
  const sourcePath = absoluteFilePath(file);
  const localText = await readTextFileIfPresent(
    sourcePath && (isWebPageDocument(document) || isMarkdownDocument(document) || isCodeDocument(document) || !file?.mimeType?.startsWith("application/"))
      ? sourcePath
      : null
  );

  const [extras, sections] = await Promise.all([
    loadViewerExtras(document.id),
    loadSections(document.id)
  ]);

  const base: ViewerPayload = {
    documentId: document.id,
    title: document.title ?? document.sourceRef,
    sourceRef: document.sourceRef,
    sourceType: document.sourceType,
    sourceUrl: document.sourceUrl ?? (/^https?:\/\//i.test(document.sourceRef) ? document.sourceRef : null),
    fileType: document.fileType,
    mimeType: document.mimeType,
    documentType: extras.documentType,
    summary: extras.summary,
    knowledgeBaseName: extras.knowledgeBaseName,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    fileSizeBytes: file?.fileSizeBytes ?? null,
    pageCount: null,
    presentation: "text",
    converted: false,
    pdfUrl: null,
    pageUrl: null,
    mediaUrl: null,
    originalUrl: file ? `/api/documents/${document.id}/original` : null,
    downloadUrl: file ? `/api/documents/${document.id}/original?download=1` : null,
    originalName: file?.originalName ?? null,
    renderedHtml: "",
    rawText: document.extractedText,
    sections,
    notice: null,
    query: options.query,
    highlight: options.highlight
  };

  // Gecrawlte Seite: die gespeicherte Kopie ist die Ansicht, der extrahierte
  // Text bleibt als eigener Tab. Ohne Kopie - Seiten aus der Zeit vor deren
  // Einfuehrung - bleibt nur der Text, mit einem Hinweis statt leerem Rahmen.
  if (isWebPageDocument(document)) {
    if (localText !== null) {
      return {
        ...base,
        presentation: "webpage",
        pageUrl: `/view/${document.id}/page`,
        rawText: document.extractedText
      };
    }

    return {
      ...base,
      presentation: "text",
      renderedHtml: `<pre class="viewer-text">${escapeHtml(document.extractedText)}</pre>`,
      notice: "Von dieser Seite gibt es keine gespeicherte Kopie. Ein erneuter Crawl legt sie an."
    };
  }

  // PDF und alles, was LibreOffice nach PDF wandeln kann, landet im
  // PDF-Betrachter - das ist bei einem Schriftstueck die Ansicht, die zaehlt.
  if (sourcePath && (isPdfFile(document.fileType, document.mimeType, sourcePath) || isOfficeConvertible(document.fileType, document.mimeType))) {
    const renditionPath = await ensurePdfRendition(sourcePath, document.fileType, document.mimeType);
    if (renditionPath) {
      const converted = renditionPath !== sourcePath;
      return {
        ...base,
        presentation: "pdf",
        converted,
        pdfUrl: `/view/${document.id}/pdf`,
        pageCount: await readPdfPageCount(renditionPath),
        notice: converted ? "Aus dem Originalformat erzeugte PDF-Fassung." : null
      };
    }

    // Konvertierung fehlgeschlagen: lieber den extrahierten Text zeigen als
    // einen Download zu erzwingen.
    return {
      ...base,
      presentation: "text",
      renderedHtml: `<pre class="viewer-text">${escapeHtml(document.extractedText)}</pre>`,
      notice: "Die Seitenansicht liess sich nicht erzeugen, hier steht der extrahierte Text."
    };
  }

  if (sourcePath && matchesType(document, IMAGE_FILE_TYPES, "image/")) {
    return {
      ...base,
      presentation: "image",
      mediaUrl: `/api/documents/${document.id}/original`,
      notice: document.extractedText.trim().length > 0 ? null : "Zu diesem Bild gibt es keinen erkannten Text."
    };
  }

  if (sourcePath && matchesType(document, AUDIO_FILE_TYPES, "audio/")) {
    return { ...base, presentation: "audio", mediaUrl: `/api/documents/${document.id}/original` };
  }

  if (sourcePath && matchesType(document, VIDEO_FILE_TYPES, "video/")) {
    return { ...base, presentation: "video", mediaUrl: `/api/documents/${document.id}/original` };
  }

  const rawText = localText ?? document.extractedText;

  if (isMarkdownDocument(document)) {
    return { ...base, presentation: "markdown", rawText, renderedHtml: await renderMarkdown(rawText) };
  }

  if (isCodeDocument(document)) {
    return {
      ...base,
      presentation: "code",
      rawText,
      renderedHtml: renderHighlightedCode(rawText, document.sourceRef, document.fileType, document.mimeType)
    };
  }

  if (rawText.trim().length > 0) {
    return {
      ...base,
      presentation: "text",
      rawText,
      renderedHtml: `<pre class="viewer-text">${escapeHtml(rawText)}</pre>`
    };
  }

  // Archiv oder unbekanntes Binaerformat: keine Ansicht, aber auch kein stiller
  // Download - der Viewer zeigt eine Karte mit Dateiangaben und Download-Knopf.
  return { ...base, presentation: "binary" };
}

// Grobe Einordnung ohne Dateizugriff, fuer Symbol und Vorschaubild in der
// Trefferliste. Die endgueltige Ansicht entscheidet buildViewerPayload.
export function previewKindFor(input: { sourceType: string; fileType: string | null; mimeType: string | null }): PresentationKind {
  const fileType = input.fileType?.toLowerCase() ?? "";
  const mimeType = input.mimeType?.toLowerCase() ?? "";

  if (input.sourceType.startsWith("crawl") || mimeType.includes("html") || ["html", "htm", "xhtml"].includes(fileType)) {
    return "webpage";
  }
  if (isPdfFile(input.fileType, input.mimeType) || isOfficeConvertible(input.fileType, input.mimeType)) {
    return "pdf";
  }
  if (IMAGE_FILE_TYPES.has(fileType) || mimeType.startsWith("image/")) {
    return "image";
  }
  if (AUDIO_FILE_TYPES.has(fileType) || mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (VIDEO_FILE_TYPES.has(fileType) || mimeType.startsWith("video/")) {
    return "video";
  }
  if (["md", "markdown", "mdx"].includes(fileType) || mimeType.includes("markdown")) {
    return "markdown";
  }
  if (CODE_FILE_TYPES.has(fileType) || input.sourceType === "git") {
    return "code";
  }
  return "text";
}
