import { logger } from "./logger";

// CVE-2026-111497: Der in Node gebuendelte Brotli-Dekoder schreibt bei
// fehlerhaft komprimierten Daten ueber einen internen Puffer von acht Byte
// hinaus. Aus einer manipulierten Antwort wird so im besten Fall ein Absturz,
// im schlechtesten fremder Code im eigenen Prozess.
//
// Erreichbar ist das hier, weil Crawl und Archiv-Abruf Antworten fremder Server
// entgegennehmen und axios komprimierte Antworten selbst auspackt. Behoben ist
// die Luecke in Node 22.23.4, 24.22.1 und 26.12.1; fuer die ausgelaufenen
// Linien (20 und aelter) gibt es keine Fassung mehr.
//
// Gewarnt wird, nicht abgebrochen: eine laufende Installation soll sich nach
// einem Update nicht selbst aussperren - aber niemand soll erst im Ernstfall
// erfahren, auf welcher Laufzeit sie steht.
const BROTLI_PATCHED_MINIMUM = [
  { major: 22, minor: 23, patch: 4 },
  { major: 24, minor: 22, patch: 1 },
  { major: 26, minor: 12, patch: 1 }
];

// Jede Linie oberhalb der hoechsten hier bekannten ist neuer als der Fix.
// Alles andere ohne eigenen Eintrag - 20 und aelter, aber auch die
// Zwischenlinien 23 und 25 - ist ausgelaufen und bleibt ungepatcht.
const NEWEST_PATCHED_LINE = 26;

export function isRuntimeBrotliVulnerable(version: string = process.versions.node): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 3) {
    // Unlesbare Versionsangabe: lieber einmal zu viel warnen als eine
    // ungepatchte Laufzeit stillschweigend durchlassen.
    return true;
  }

  const [major, minor, patch] = parts;
  const line = BROTLI_PATCHED_MINIMUM.find((entry) => entry.major === major);
  if (!line) {
    return major < NEWEST_PATCHED_LINE;
  }

  if (minor !== line.minor) {
    return minor < line.minor;
  }

  return patch < line.patch;
}

export function warnIfRuntimeBrotliVulnerable(component: string): void {
  if (!isRuntimeBrotliVulnerable()) {
    return;
  }

  logger.warn(
    {
      component,
      nodeVersion: process.versions.node,
      cve: "CVE-2026-111497",
      fixedIn: BROTLI_PATCHED_MINIMUM.map((entry) => `${entry.major}.${entry.minor}.${entry.patch}`)
    },
    "this Node version contains the vulnerable Brotli decoder (CVE-2026-111497); upgrade the runtime"
  );
}
