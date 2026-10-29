import { pool } from "../db/pool";
import { IngestionService } from "./ingestionService";
import { deleteStoredDocumentAssets } from "./originalFileService";
import { searchIndexService } from "./searchIndexService";
import { logger } from "../utils/logger";

// Wissen, das ein Agent selbst anlegt. Zwei Dinge unterscheiden diesen Pfad von
// jeder anderen Aufnahme:
//
// Erstens hat jedes Stueck einen stabilen Schluessel. Ohne ihn legt jede
// Ueberarbeitung ein neues Dokument an und das alte bleibt liegen - nach drei
// Runden widersprechen sich drei Fassungen derselben Notiz.
//
// Zweitens laeuft keine Klassifizierung. Die ist ein LLM-Roundtrip vor dem
// Chunking; ein Schreibwerkzeug, das darauf wartet, blockiert den Agenten
// minutenlang.

export const AGENT_NOTE_SOURCE_TYPE = "opencode-note";
export const AGENT_FILE_SOURCE_TYPE = "opencode-file";

export interface AgentWriteResult {
  documentId: number;
  sourceRef: string;
  replacedDocumentId: number | null;
  chunkCount: number;
  containsSecrets: boolean;
  secretKinds: string[];
}

// Muster fuer offensichtliche Zugangsdaten. Bewusst eng gehalten: dieser Fund
// loest eine Markierung aus, keine Ablehnung - ein falscher Treffer soll kein
// Wissen verhindern, ein echter aber auffindbar bleiben.
const SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: "slack-token", pattern: /\bxox[abps]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i },
  { kind: "assignment", pattern: /\b(password|passwort|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"'<>]{8,}/i }
];

export function detectSecrets(text: string): string[] {
  return SECRET_PATTERNS
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => entry.kind);
}

export function buildNoteSourceRef(noteKey: string): string {
  return `opencode://note/${normalizeKey(noteKey)}`;
}

export function buildFileSourceRef(filePath: string): string {
  return `opencode://file/${normalizeFilePath(filePath)}`;
}

export function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._/-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
}

export function normalizeFilePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    // Kein Verzeichniswechsel nach oben: der Pfad ist nur ein Name, aber er
    // landet in Ausgaben und soll nicht aussehen, als zeige er irgendwohin.
    .split("/")
    .filter((segment) => segment !== "." && segment !== "..")
    .join("/");
}

// Entfernt ein Dokument samt Chunks, Abschnitten und abgelegten Dateien.
// Dieselbe Reihenfolge wie DELETE /api/documents/:id - hier als Service, weil
// der Schreibpfad sie vor jedem Ueberschreiben braucht.
export async function deleteDocumentCompletely(documentId: number): Promise<boolean> {
  const result = await pool.query<{ id: number }>(
    "DELETE FROM documents WHERE id = $1 RETURNING id",
    [documentId]
  );

  if (result.rowCount === 0) {
    return false;
  }

  try {
    await deleteStoredDocumentAssets(documentId);
  } catch (error) {
    logger.warn({ err: error, documentId }, "failed to clean up stored document assets after deletion");
  }

  if (searchIndexService.isEnabled()) {
    try {
      await searchIndexService.deleteDocument(documentId);
    } catch (error) {
      logger.warn({ err: error, documentId }, "failed to delete document from elasticsearch index");
    }
  }

  return true;
}

async function findExistingDocumentId(sourceRef: string, knowledgeBaseId: number | null): Promise<number | null> {
  const result = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM documents
      WHERE source_ref = $1
        AND COALESCE(knowledge_base_id, 0) = COALESCE($2::bigint, 0)
      ORDER BY id DESC
      LIMIT 1
    `,
    [sourceRef, knowledgeBaseId]
  );

  return result.rows[0] ? Number(result.rows[0].id) : null;
}

export class AgentKnowledgeService {
  constructor(private readonly ingestionService = new IngestionService()) {}

  async saveNote(input: {
    noteKey: string;
    title: string;
    text: string;
    tags?: string[];
    knowledgeBaseId: number | null;
    principalName: string | null;
  }): Promise<AgentWriteResult> {
    const noteKey = normalizeKey(input.noteKey);
    if (!noteKey) {
      throw new Error("noteKey must contain at least one usable character");
    }

    const sourceRef = buildNoteSourceRef(noteKey);
    const title = input.title.trim() || noteKey;
    const tags = (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean);

    // Der Kopf macht den Text eindeutig. documents.content_hash gilt
    // systemweit: ohne ihn bekaeme der Agent beim Speichern eines Wortlauts,
    // der schon anderswo steht, jenes fremde Dokument als Duplikat zurueck.
    const body = [
      `# ${title}`,
      `Notiz: ${noteKey}`,
      tags.length > 0 ? `Schlagworte: ${tags.join(", ")}` : null,
      `Gespeichert: ${new Date().toISOString()}`,
      "",
      input.text.trim()
    ].filter((line) => line !== null).join("\n");

    return this.writeDocument({
      sourceRef,
      title,
      text: body,
      sourceType: AGENT_NOTE_SOURCE_TYPE,
      documentType: "documentation",
      fileType: "md",
      mimeType: "text/markdown",
      knowledgeBaseId: input.knowledgeBaseId,
      metadata: {
        author: "opencode",
        noteKey,
        tags,
        principal: input.principalName
      }
    });
  }

  async saveFile(input: {
    path: string;
    content: string;
    language?: string;
    knowledgeBaseId: number | null;
    principalName: string | null;
  }): Promise<AgentWriteResult> {
    const filePath = normalizeFilePath(input.path);
    if (!filePath) {
      throw new Error("path must contain at least one usable segment");
    }

    const sourceRef = buildFileSourceRef(filePath);
    const extension = filePath.includes(".") ? filePath.split(".").pop()!.toLowerCase() : null;
    const body = [
      `// Datei: ${filePath}`,
      input.language ? `// Sprache: ${input.language}` : null,
      "",
      input.content
    ].filter((line) => line !== null).join("\n");

    return this.writeDocument({
      sourceRef,
      title: filePath,
      text: body,
      sourceType: AGENT_FILE_SOURCE_TYPE,
      documentType: "source_code",
      fileType: input.language?.toLowerCase() || extension || "txt",
      mimeType: "text/plain",
      knowledgeBaseId: input.knowledgeBaseId,
      metadata: {
        author: "opencode",
        path: filePath,
        language: input.language ?? extension ?? null,
        principal: input.principalName
      }
    });
  }

  async forget(input: { sourceRef: string; knowledgeBaseId: number | null }): Promise<boolean> {
    const existingId = await findExistingDocumentId(input.sourceRef, input.knowledgeBaseId);
    if (existingId === null) {
      return false;
    }

    return deleteDocumentCompletely(existingId);
  }

  private async writeDocument(input: {
    sourceRef: string;
    title: string;
    text: string;
    sourceType: string;
    documentType: string;
    fileType: string;
    mimeType: string;
    knowledgeBaseId: number | null;
    metadata: Record<string, unknown>;
  }): Promise<AgentWriteResult> {
    const secretKinds = detectSecrets(input.text);
    if (secretKinds.length > 0) {
      logger.warn(
        { sourceRef: input.sourceRef, secretKinds },
        "agent knowledge contains possible credentials; storing it marked"
      );
    }

    // Erst loeschen, dann schreiben. Ein Update an Ort und Stelle muesste
    // Chunks, Abschnitte und Einbettungen einzeln nachziehen; so bleibt der
    // gespeicherte Stand immer vollstaendig zum Text passend.
    const replacedDocumentId = await findExistingDocumentId(input.sourceRef, input.knowledgeBaseId);
    if (replacedDocumentId !== null) {
      await deleteDocumentCompletely(replacedDocumentId);
    }

    const result = await this.ingestionService.ingestText({
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      knowledgeBaseId: input.knowledgeBaseId,
      title: input.title,
      text: input.text,
      mimeType: input.mimeType,
      fileType: input.fileType,
      documentType: input.documentType,
      skipClassification: true,
      metadata: {
        ...input.metadata,
        writtenAt: new Date().toISOString(),
        ...(replacedDocumentId !== null ? { supersededDocumentId: replacedDocumentId } : {}),
        ...(secretKinds.length > 0 ? { containsSecrets: true, secretKinds } : {})
      }
    });

    return {
      documentId: Number(result.documentId),
      sourceRef: input.sourceRef,
      replacedDocumentId,
      chunkCount: result.chunkCount,
      containsSecrets: secretKinds.length > 0,
      secretKinds
    };
  }
}
