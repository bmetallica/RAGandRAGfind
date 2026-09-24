import { execFile } from "node:child_process";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../utils/logger";

const run = promisify(execFile);

// Abgeleitete Dateien liegen neben dem Original, in einem Unterordner des
// Dokumentverzeichnisses. Damit raeumt deleteStoredDocumentAssets sie mit weg -
// ein eigener Cache-Baum bliebe nach dem Loeschen eines Dokuments liegen.
const DERIVED_DIR_NAME = ".derived";

// Formate, die LibreOffice zuverlaessig nach PDF wandelt. Alles andere wird
// nicht konvertiert, sondern bekommt im Viewer die Download-Karte.
const OFFICE_CONVERTIBLE_FILE_TYPES = new Set([
  "doc", "docx", "odt", "rtf", "dot", "dotx",
  "xls", "xlsx", "ods", "csv",
  "ppt", "pptx", "odp"
]);

const OFFICE_CONVERTIBLE_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.presentation"
]);

// Zwei Anfragen auf dasselbe Dokument sollen LibreOffice nicht zweimal starten.
// Der zweite Aufruf haengt sich an die laufende Konvertierung.
const inFlight = new Map<string, Promise<string | null>>();

function once<T>(key: string, factory: () => Promise<T | null>): Promise<T | null> {
  const existing = inFlight.get(key);
  if (existing) {
    return existing as Promise<T | null>;
  }

  const pending = factory().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, pending as Promise<string | null>);
  return pending;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Eine abgeleitete Datei gilt nur so lange, wie sie juenger ist als ihre
// Quelle. Wird das Original ersetzt, faellt der Cache damit von selbst weg.
async function isFresherThan(candidate: string, source: string): Promise<boolean> {
  try {
    const [candidateStat, sourceStat] = await Promise.all([stat(candidate), stat(source)]);
    return candidateStat.mtimeMs >= sourceStat.mtimeMs && candidateStat.size > 0;
  } catch {
    return false;
  }
}

function derivedDirFor(sourcePath: string): string {
  return path.join(path.dirname(sourcePath), DERIVED_DIR_NAME);
}

export function isPdfFile(fileType: string | null, mimeType: string | null, sourcePath?: string | null): boolean {
  const normalizedType = fileType?.toLowerCase() ?? "";
  const normalizedMime = mimeType?.toLowerCase() ?? "";
  return normalizedType === "pdf"
    || normalizedMime.includes("application/pdf")
    || (sourcePath ?? "").toLowerCase().endsWith(".pdf");
}

export function isOfficeConvertible(fileType: string | null, mimeType: string | null): boolean {
  const normalizedType = fileType?.toLowerCase() ?? "";
  const normalizedMime = (mimeType?.toLowerCase() ?? "").split(";")[0].trim();
  return OFFICE_CONVERTIBLE_FILE_TYPES.has(normalizedType) || OFFICE_CONVERTIBLE_MIME_TYPES.has(normalizedMime);
}

// Liefert den Pfad zu einer PDF-Fassung des Dokuments: das Original selbst,
// wenn es schon ein PDF ist, sonst eine von LibreOffice erzeugte Kopie.
// Gibt null zurueck, wenn sich das Format nicht wandeln laesst.
export async function ensurePdfRendition(
  sourcePath: string,
  fileType: string | null,
  mimeType: string | null
): Promise<string | null> {
  if (!(await pathExists(sourcePath))) {
    return null;
  }

  if (isPdfFile(fileType, mimeType, sourcePath)) {
    return sourcePath;
  }

  if (!isOfficeConvertible(fileType, mimeType)) {
    return null;
  }

  const targetDir = derivedDirFor(sourcePath);
  const targetPath = path.join(targetDir, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);

  if (await isFresherThan(targetPath, sourcePath)) {
    return targetPath;
  }

  return once(`pdf:${sourcePath}`, async () => {
    // Noch einmal pruefen: waehrend des Wartens auf den Lock kann eine andere
    // Anfrage die Konvertierung bereits abgeschlossen haben.
    if (await isFresherThan(targetPath, sourcePath)) {
      return targetPath;
    }

    await mkdir(targetDir, { recursive: true });
    // Der Arbeitsordner liegt bewusst im Zielverzeichnis und nicht unter /tmp:
    // das Ablageverzeichnis ist ein eigenes Dateisystem, und ein Verschieben
    // darueber hinweg scheitert mit EXDEV. Innerhalb desselben Dateisystems
    // ist das Umbenennen ausserdem atomar - halbfertige Dateien werden nie
    // sichtbar.
    const workDir = path.join(targetDir, `.tmp-${process.pid}-${Date.now()}`);
    await mkdir(workDir, { recursive: true });

    try {
      await run(
        "soffice",
        [
          // Ohne eigenes Benutzerprofil bricht LibreOffice ab, sobald zwei
          // Instanzen gleichzeitig laufen oder HOME nicht beschreibbar ist.
          `-env:UserInstallation=file://${workDir}/profile`,
          "--headless",
          "--norestore",
          "--nolockcheck",
          "--convert-to",
          "pdf",
          "--outdir",
          workDir,
          sourcePath
        ],
        { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }
      );

      const producedPath = path.join(workDir, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
      if (!(await pathExists(producedPath))) {
        logger.warn({ sourcePath }, "libreoffice produced no pdf rendition");
        return null;
      }

      await rename(producedPath, targetPath);
      return targetPath;
    } catch (error) {
      logger.warn({ err: error, sourcePath }, "pdf rendition failed");
      return null;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

// Rendert die erste Seite eines PDF als JPEG fuer die Trefferliste.
export async function ensurePdfThumbnail(pdfPath: string): Promise<string | null> {
  const targetDir = derivedDirFor(pdfPath);
  const targetPrefix = path.join(targetDir, "thumb");
  const targetPath = `${targetPrefix}.jpg`;

  if (await isFresherThan(targetPath, pdfPath)) {
    return targetPath;
  }

  return once(`thumb:${pdfPath}`, async () => {
    if (await isFresherThan(targetPath, pdfPath)) {
      return targetPath;
    }

    await mkdir(targetDir, { recursive: true });
    try {
      await run(
        "pdftoppm",
        ["-jpeg", "-jpegopt", "quality=72", "-r", "48", "-f", "1", "-l", "1", "-singlefile", pdfPath, targetPrefix],
        { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
      );
      return (await pathExists(targetPath)) ? targetPath : null;
    } catch (error) {
      logger.warn({ err: error, pdfPath }, "pdf thumbnail failed");
      return null;
    }
  });
}

// Seitenzahl fuers Kopf-Badge. Faellt still aus, wenn pdfinfo nichts liefert -
// eine fehlende Zahl ist kein Grund, die Ansicht scheitern zu lassen.
export async function readPdfPageCount(pdfPath: string): Promise<number | null> {
  try {
    const { stdout } = await run("pdfinfo", [pdfPath], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const match = stdout.match(/^Pages:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
