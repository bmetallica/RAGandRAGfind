import { escapeHtml, type ViewerPayload } from "./viewerModel";

// Die Seite liefert nur Geruest und Nutzdaten; gerendert wird in
// public/ragfind/viewer.js. Fruehere Fassungen trugen Markup, Stil und Logik
// als ein einziges Template im Server - der PDF-Betrachter braucht ein echtes
// Modul, und ein Stylesheet laesst sich im Browser zwischenspeichern.
export function renderViewerShell(payload: ViewerPayload): string {
  const json = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(payload.title)} | RAGfind</title>
    <link rel="stylesheet" href="/styles.css" />
    <link rel="stylesheet" href="/pdfjs/web/pdf_viewer.css" />
    <link rel="stylesheet" href="/viewer.css" />
  </head>
  <body>
    <div class="viewer-shell" id="viewer-shell"></div>
    <script id="viewer-payload" type="application/json">${json}</script>
    <script type="module" src="/viewer.js"></script>
  </body>
</html>`;
}

// Notausgang fuer gecrawlte Dokumente ohne lokale Datei: der Originalabruf
// liefert dann wenigstens den extrahierten Text als lesbare Seite.
export function renderExtractedTextPage(title: string, extractedText: string): string {
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: #f5f1e8; color: #1f2328; }
      main { max-width: 980px; margin: 0 auto; padding: 32px 20px 48px; }
      h1 { margin: 0 0 8px; font-size: 2rem; }
      p { margin: 0 0 24px; color: #5b6470; }
      pre {
        margin: 0; padding: 24px; white-space: pre-wrap; word-break: break-word;
        background: rgba(255,255,255,0.82); border: 1px solid rgba(15,23,42,0.08);
        border-radius: 18px; font: 16px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #10151d; color: #f2f5f8; }
        p { color: #a7b0bc; }
        pre { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08); }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>Lokale gespeicherte Kopie aus RAGfind.</p>
      <pre>${escapeHtml(extractedText)}</pre>
    </main>
  </body>
</html>`;
}
