import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import * as cheerio from "cheerio";
import mime from "mime-types";
import { env } from "../config/env";
import { IngestionService } from "./ingestionService";
import { isDownloadableDocument } from "../utils/files";

interface CrawlOptions {
  startUrl: string;
  maxDepth?: number;
  knowledgeBaseId?: number | null;
}

interface QueueEntry {
  url: string;
  depth: number;
}

// Ablagefaehige Kopie der Seite. Der RAGfind-Viewer rendert eine als Original
// gespeicherte HTML-Datei direkt (siehe buildViewerContent), deshalb landet hier
// echtes HTML und nicht der extrahierte Text.
//
// Entfernt wird alles Ausfuehrbare - Skripte, eingebettete Fremdinhalte,
// Formulare und on*-Attribute. Ohne das waere jede gecrawlte Seite gespeichertes
// XSS im RAGfind-Ursprung. Stylesheets bleiben erhalten, sonst sieht die
// Archivkopie nicht wie die Seite aus; zusammen mit dem eingefuegten <base>
// laedt der Browser sie beim Betrachten von der Originalseite nach.
function buildStorableHtml(html: string, finalUrl: string): string {
  const $ = cheerio.load(html);

  $("script, noscript, iframe, object, embed, form, applet").remove();
  $("*").each((_, element) => {
    const attribs = (element as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      const value = attribs[name] ?? "";
      if (name.toLowerCase().startsWith("on") || /^\s*javascript:/i.test(value)) {
        $(element).removeAttr(name);
      }
    }
  });

  // Relative Pfade zu Stylesheets, Bildern und Links zeigen sonst ins Leere,
  // weil die Kopie unter einer anderen Herkunft ausgeliefert wird.
  const head = $("head").first();
  if (head.length > 0) {
    head.find("base").remove();
    head.prepend(`<base href="${finalUrl.replace(/"/g, "&quot;")}">`);
  }

  return $.html();
}

function buildPageFileName(finalUrl: string): string {
  try {
    const segment = new URL(finalUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    const cleaned = segment.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
    if (!cleaned) {
      return "index.html";
    }
    return /\.html?$/i.test(cleaned) ? cleaned : `${cleaned}.html`;
  } catch {
    return "index.html";
  }
}

function resolveFinalResponseUrl(response: { request?: { res?: { responseUrl?: string }; responseURL?: string } }, fallbackUrl: string): string {
  const responseUrl = response.request?.res?.responseUrl ?? response.request?.responseURL;
  if (!responseUrl) {
    return fallbackUrl;
  }

  try {
    return new URL(responseUrl).toString();
  } catch {
    return fallbackUrl;
  }
}

export class CrawlService {
  constructor(private readonly ingestionService = new IngestionService()) {}

  async crawl(options: CrawlOptions): Promise<{ pages: number; files: number; duplicates: number }> {
    const startUrl = new URL(options.startUrl);
    const maxDepth = options.maxDepth ?? env.CRAWL_DEFAULT_MAX_DEPTH;
    const allowedOrigins = new Set<string>([startUrl.origin]);
    const visited = new Set<string>();
    const queue: QueueEntry[] = [{ url: startUrl.toString(), depth: 0 }];
    let pages = 0;
    let files = 0;
    let duplicates = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.url)) {
        continue;
      }

      visited.add(current.url);
      const response = await axios.get<ArrayBuffer>(current.url, {
        responseType: "arraybuffer",
        timeout: 30_000,
        validateStatus: (status) => status >= 200 && status < 400
      });
      const finalUrl = resolveFinalResponseUrl(response, current.url);
      const finalLocation = new URL(finalUrl);
      allowedOrigins.add(finalLocation.origin);
      visited.add(finalUrl);

      const contentType = response.headers["content-type"] ?? mime.lookup(finalUrl) ?? "application/octet-stream";
      if (!String(contentType).includes("text/html") && isDownloadableDocument(finalUrl)) {
        const result = await this.ingestRemoteFile(finalUrl, Buffer.from(response.data), options.knowledgeBaseId ?? null);
        files += 1;
        if (result.duplicate) {
          duplicates += 1;
        }
        continue;
      }

      const html = Buffer.from(response.data).toString("utf8");
      const $ = cheerio.load(html);
      $("script, style, noscript").remove();
      const title = $("title").first().text().trim() || finalUrl;
      const bodyText = $("body").text().replace(/\s+/g, " ").trim();

      if (bodyText) {
        const result = await this.ingestPage({
          finalUrl,
          title,
          bodyText,
          html,
          contentType: String(contentType),
          knowledgeBaseId: options.knowledgeBaseId ?? null,
          depth: current.depth,
          requestedUrl: current.url
        });

        pages += 1;
        if (result.duplicate) {
          duplicates += 1;
        }
      }

      if (current.depth >= maxDepth) {
        continue;
      }

      const links = $("a[href]")
        .map((_, element) => $(element).attr("href"))
        .get()
        .filter(Boolean) as string[];

      for (const href of links) {
        const resolved = new URL(href, finalUrl);
        if (!allowedOrigins.has(resolved.origin)) {
          continue;
        }

        if (isDownloadableDocument(resolved.toString())) {
          const fileResponse = await axios.get<ArrayBuffer>(resolved.toString(), {
            responseType: "arraybuffer",
            timeout: 30_000,
            validateStatus: (status) => status >= 200 && status < 400
          });
          const result = await this.ingestRemoteFile(resolved.toString(), Buffer.from(fileResponse.data), options.knowledgeBaseId ?? null);
          files += 1;
          if (result.duplicate) {
            duplicates += 1;
          }
          continue;
        }

        if (!visited.has(resolved.toString())) {
          queue.push({ url: resolved.toString(), depth: current.depth + 1 });
        }
      }
    }

    return { pages, files, duplicates };
  }

  // Speichert neben dem extrahierten Text eine bereinigte HTML-Kopie als
  // Originaldatei. Der RAGfind-Viewer bevorzugt diese Datei gegenueber dem
  // extrahierten Text und zeigt die Fundstelle dadurch als Seite statt als
  // Fliesstext (siehe buildViewerContent in src/ragfind/server.ts).
  private async ingestPage(input: {
    finalUrl: string;
    title: string;
    bodyText: string;
    html: string;
    contentType: string;
    knowledgeBaseId: number | null;
    depth: number;
    requestedUrl: string;
  }) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-crawl-page-"));
    try {
      const fileName = buildPageFileName(input.finalUrl);
      const filePath = path.join(tempDir, fileName);
      await writeFile(filePath, buildStorableHtml(input.html, input.finalUrl), "utf8");

      // Wie in ingestRemoteFile: ohne `await` raeumt das `finally` das
      // Verzeichnis weg, bevor die Datei kopiert wurde.
      return await this.ingestionService.ingestText({
        sourceType: "crawl",
        sourceRef: input.finalUrl,
        knowledgeBaseId: input.knowledgeBaseId,
        sourceUrl: input.finalUrl,
        title: input.title,
        text: input.bodyText,
        mimeType: input.contentType,
        fileType: "html",
        originalFilePath: filePath,
        originalFileName: fileName,
        originalExternalUrl: input.finalUrl,
        metadata: {
          crawlDepth: input.depth,
          redirectSourceUrl: input.finalUrl !== input.requestedUrl ? input.requestedUrl : undefined
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async ingestRemoteFile(url: string, buffer: Buffer, knowledgeBaseId?: number | null) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-crawl-"));
    try {
      const pathname = new URL(url).pathname;
      const baseName = path.basename(pathname) || "downloaded-file";
      const filePath = path.join(tempDir, baseName);
      await writeFile(filePath, buffer);
      // `await` ist hier zwingend: ohne es laeuft das `finally` unten los,
      // sobald ingestFile die Promise zurueckgibt - also waehrend die
      // Extraktion noch laeuft. Das Temp-Verzeichnis war dann schon geloescht,
      // und OCR scheiterte mit "cannot read input file ... No such file".
      return await this.ingestionService.ingestFile({
        filePath,
        sourceType: "crawl-file",
        sourceRef: url,
        knowledgeBaseId: knowledgeBaseId ?? null,
        sourceUrl: url,
        metadata: {
          downloadedFrom: url
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
