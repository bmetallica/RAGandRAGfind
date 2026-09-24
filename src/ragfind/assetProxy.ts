import dns from "node:dns/promises";
import net from "node:net";
import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "../utils/logger";

// Warum es diesen Umweg gibt
//
// Eine gespeicherte Seite liegt unter der Adresse von RAGfind, ihre Bilder und
// Stylesheets aber unter der des Originals. Viele Seiten - bmetallica.de
// eingeschlossen - senden darauf "Cross-Origin-Resource-Policy: same-site".
// Der Browser blockiert sie dann fuer jedes fremde Dokument, ganz gleich wie
// grosszuegig dessen eigene Content-Security-Policy ist. Die Kopie erschiene
// als nackter Text. Deshalb werden die Verweise beim Ausliefern auf diesen
// Endpunkt umgebogen: er holt die Datei serverseitig und liefert sie unter
// derselben Herkunft wie die Kopie aus.

const ASSET_TIMEOUT_MS = 12_000;
const ASSET_MAX_BYTES = 12 * 1024 * 1024;

const ALLOWED_CONTENT_TYPE_PREFIXES = [
  "text/css",
  "image/",
  "font/",
  "audio/",
  "video/",
  "application/font",
  "application/x-font",
  "application/vnd.ms-fontobject",
  "application/octet-stream"
];

export function buildAssetProxyUrl(documentId: number | string, absoluteUrl: string): string {
  return `/view/${documentId}/asset?u=${encodeURIComponent(absoluteUrl)}`;
}

function resolveAbsolute(rawUrl: string, baseUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:") || trimmed.startsWith("#")) {
    return null;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : null;
  } catch {
    return null;
  }
}

// srcset ist eine Liste aus Adresse plus optionalem Groessenzusatz. Ohne
// eigenes Zerlegen ginge bei responsiven Bildern jede Variante verloren.
function rewriteSrcset(value: string, baseUrl: string, documentId: number | string): string {
  return value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      if (parts.length === 0 || !parts[0]) {
        return null;
      }
      const absolute = resolveAbsolute(parts[0], baseUrl);
      if (!absolute) {
        return candidate.trim();
      }
      return [buildAssetProxyUrl(documentId, absolute), ...parts.slice(1)].join(" ");
    })
    .filter((candidate): candidate is string => Boolean(candidate))
    .join(", ");
}

export function rewriteCssUrls(css: string, baseUrl: string, documentId: number | string): string {
  const withUrls = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, rawUrl) => {
    const absolute = resolveAbsolute(rawUrl, baseUrl);
    return absolute ? `url(${quote}${buildAssetProxyUrl(documentId, absolute)}${quote})` : match;
  });

  // @import ohne url(): "@import 'a.css';"
  return withUrls.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, rawUrl) => {
    const absolute = resolveAbsolute(rawUrl, baseUrl);
    return absolute ? `@import ${quote}${buildAssetProxyUrl(documentId, absolute)}${quote}` : match;
  });
}

// Biegt in der gespeicherten Kopie alles um, was der Browser nachlaedt.
// Verweise auf andere Seiten bleiben, wie sie sind: sie sollen weiterhin auf
// das Original zeigen.
export function rewriteStoredPage(html: string, pageUrl: string, documentId: number | string): string {
  const $ = cheerio.load(html);
  const baseHref = $("base[href]").first().attr("href");
  const baseUrl = baseHref || pageUrl;

  $("link[rel]").each((_index, element) => {
    const link = $(element);
    const rel = (link.attr("rel") ?? "").toLowerCase();
    if (!/stylesheet|icon|preload/.test(rel)) {
      return;
    }
    const absolute = resolveAbsolute(link.attr("href") ?? "", baseUrl);
    if (absolute) {
      link.attr("href", buildAssetProxyUrl(documentId, absolute));
    }
  });

  $("img, source, video, audio, embed, track").each((_index, element) => {
    const node = $(element);
    for (const attribute of ["src", "poster"]) {
      const absolute = resolveAbsolute(node.attr(attribute) ?? "", baseUrl);
      if (absolute) {
        node.attr(attribute, buildAssetProxyUrl(documentId, absolute));
      }
    }
    const srcset = node.attr("srcset");
    if (srcset) {
      node.attr("srcset", rewriteSrcset(srcset, baseUrl, documentId));
    }
  });

  // Verweise auf andere Seiten werden absolut gemacht, bevor das base-Tag
  // faellt. Es muss fallen: sonst zieht es auch die Proxy-Pfade auf die
  // Originaldomain, und der Browser holt sie dort statt hier.
  $("a[href], area[href]").each((_index, element) => {
    const node = $(element);
    const href = node.attr("href") ?? "";
    if (href.startsWith("#")) {
      return;
    }
    const absolute = resolveAbsolute(href, baseUrl);
    if (absolute) {
      node.attr("href", absolute);
    }
  });

  $("form[action]").each((_index, element) => {
    const node = $(element);
    const absolute = resolveAbsolute(node.attr("action") ?? "", baseUrl);
    if (absolute) {
      node.attr("action", absolute);
    }
  });

  $("style").each((_index, element) => {
    const style = $(element);
    style.text(rewriteCssUrls(style.text(), baseUrl, documentId));
  });

  $("[style]").each((_index, element) => {
    const node = $(element);
    node.attr("style", rewriteCssUrls(node.attr("style") ?? "", baseUrl, documentId));
  });

  $("base").remove();

  return $.html();
}

// Der Endpunkt holt Adressen, die in einer gecrawlten Seite standen. Damit
// daraus kein Weg ins eigene Netz wird, gehen nur oeffentliche Adressen durch.
function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    if (octets[0] === 10 || octets[0] === 127 || octets[0] === 0) {
      return true;
    }
    if (octets[0] === 169 && octets[1] === 254) {
      return true;
    }
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
      return true;
    }
    if (octets[0] === 192 && octets[1] === 168) {
      return true;
    }
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
      return true;
    }
    return false;
  }

  const normalized = address.toLowerCase();
  return normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80")
    || normalized.startsWith("::ffff:127.")
    || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.");
}

export interface FetchedAsset {
  contentType: string;
  body: Buffer;
}

export async function fetchRemoteAsset(rawUrl: string): Promise<FetchedAsset | null> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return null;
  }

  try {
    const addresses = await dns.lookup(target.hostname, { all: true });
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      logger.warn({ url: rawUrl }, "asset proxy refused a non-public address");
      return null;
    }
  } catch {
    return null;
  }

  try {
    const response = await axios.get<ArrayBuffer>(target.toString(), {
      responseType: "arraybuffer",
      timeout: ASSET_TIMEOUT_MS,
      maxContentLength: ASSET_MAX_BYTES,
      maxRedirects: 3,
      // Ohne Referrer erfaehrt die Originalseite nicht, aus welchem Archiv der
      // Abruf kommt - dieselbe Zurueckhaltung wie beim Rahmen selbst.
      headers: { "User-Agent": "RAGfind-Archive/1.0", Accept: "*/*" },
      validateStatus: (status) => status >= 200 && status < 300
    });

    const contentType = String(response.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
      logger.debug({ url: rawUrl, contentType }, "asset proxy refused an unexpected content type");
      return null;
    }

    return { contentType, body: Buffer.from(response.data) };
  } catch (error) {
    logger.debug({ err: error, url: rawUrl }, "asset proxy request failed");
    return null;
  }
}
