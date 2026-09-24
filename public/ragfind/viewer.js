// Dokumentansicht. Welche Darstellung ein Dokument bekommt, entscheidet der
// Server (siehe src/ragfind/viewerModel.ts); hier wird sie gebaut.

const payload = JSON.parse(document.getElementById("viewer-payload").textContent);
const shell = document.getElementById("viewer-shell");

const PRESENTATION_LABELS = {
  pdf: "Seitenansicht",
  webpage: "Gespeicherte Webseite",
  image: "Bild",
  audio: "Audio",
  video: "Video",
  markdown: "Markdown",
  code: "Quelltext",
  text: "Textansicht",
  binary: "Datei"
};

const DOCUMENT_TYPE_LABELS = {
  invoice: "Rechnung",
  contract: "Vertrag",
  manual: "Handbuch",
  runbook: "Runbook",
  protocol: "Protokoll",
  email: "E-Mail",
  policy: "Richtlinie",
  ticket: "Ticket",
  source_code: "Quelltext",
  documentation: "Dokumentation",
  config: "Konfiguration",
  book: "Buch",
  web: "Webseite"
};

function applyStoredTheme() {
  const stored = localStorage.getItem("ragfind-theme") || "system";
  const resolved = stored === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : stored;
  document.body.dataset.theme = resolved;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = text;
  }
  return node;
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) {
    return null;
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function documentTypeLabel(value) {
  if (!value) {
    return null;
  }
  return DOCUMENT_TYPE_LABELS[value] || value;
}

// Suchbegriffe fuer die Hervorhebung: die Anfrage selbst, und bei einem
// angeklickten Textausschnitt zusaetzlich dessen Wortlaut.
function queryTerms() {
  return [...new Set(
    (payload.query || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 3)
  )];
}

function highlightPhrase() {
  const highlight = (payload.highlight || "").replace(/^\.{3}|\.{3}$/g, "").trim();
  if (!highlight) {
    return "";
  }
  // Lange Ausschnitte finden im PDF selten eine exakte Entsprechung, weil die
  // Textextraktion Zeilenumbrueche und Ligaturen anders setzt. Ein kurzer
  // Ausschnitt aus der Mitte trifft zuverlaessiger.
  return highlight.split(/\s+/).slice(0, 8).join(" ");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHighlightedFragment(text, terms) {
  const fragment = document.createDocumentFragment();
  if (terms.length === 0) {
    fragment.append(document.createTextNode(text));
    return { fragment, marks: [] };
  }

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
  const marks = [];
  let lastIndex = 0;
  let match = pattern.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const mark = el("mark", null, match[0]);
    marks.push(mark);
    fragment.append(mark);
    lastIndex = match.index + match[0].length;
    match = pattern.exec(text);
  }

  if (lastIndex < text.length) {
    fragment.append(document.createTextNode(text.slice(lastIndex)));
  }

  return { fragment, marks };
}

/* Kopfbereich ------------------------------------------------------------- */

function buildTopbar() {
  const topbar = el("header", "viewer-topbar");

  const brand = el("a", "results-brand");
  brand.href = payload.query ? `/?q=${encodeURIComponent(payload.query)}` : "/";
  const logo = el("span", "logo logo--small");
  logo.setAttribute("aria-hidden", "true");
  for (const [letter, cssClass] of [["R", "r"], ["A", "a"], ["G", "g"], ["f", "f"], ["i", "i"], ["n", "n"], ["d", "d"]]) {
    logo.append(el("span", `logo__${cssClass}`, letter));
  }
  brand.append(logo);

  const back = el("a", "viewer-back", payload.query ? `← Zurück zu „${payload.query}“` : "← Zur Suche");
  back.href = payload.query ? `/?q=${encodeURIComponent(payload.query)}` : "/";
  back.addEventListener("click", (event) => {
    // Kommt der Besucher aus der Trefferliste, bringt ihn der Verlauf dorthin
    // zurueck - samt Scrollposition und gesetzten Filtern.
    if (document.referrer && new URL(document.referrer, location.href).origin === location.origin && history.length > 1) {
      event.preventDefault();
      history.back();
    }
  });

  const themeToggle = el("button", "theme-toggle", "Ansicht wechseln");
  themeToggle.type = "button";
  themeToggle.addEventListener("click", () => {
    const current = localStorage.getItem("ragfind-theme") || "system";
    const next = current === "light" ? "dark" : current === "dark" ? "system" : "light";
    localStorage.setItem("ragfind-theme", next);
    applyStoredTheme();
  });

  topbar.append(brand, back, el("div", "viewer-topbar__spacer"), themeToggle);
  return topbar;
}

function buildHeader() {
  const header = el("header", "viewer-header");
  header.append(el("h1", "viewer-title", payload.title));

  const source = el("p", "viewer-source");
  if (payload.sourceUrl) {
    const link = el("a", null, payload.sourceRef || payload.sourceUrl);
    link.href = payload.sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    source.append(link);
  } else {
    source.textContent = payload.sourceRef;
  }
  header.append(source);

  const badges = el("div", "viewer-badges");
  const entries = [
    documentTypeLabel(payload.documentType),
    payload.knowledgeBaseName,
    payload.fileType ? `.${payload.fileType}` : null,
    payload.pageCount ? `${payload.pageCount} ${payload.pageCount === 1 ? "Seite" : "Seiten"}` : null,
    formatBytes(payload.fileSizeBytes),
    formatDate(payload.updatedAt)
  ].filter(Boolean);

  badges.append(el("span", "badge badge--accent", PRESENTATION_LABELS[payload.presentation] || "Ansicht"));
  for (const entry of entries) {
    badges.append(el("span", "badge", entry));
  }
  header.append(badges);

  if (payload.summary) {
    header.append(el("p", "viewer-summary", payload.summary));
  }
  if (payload.notice) {
    header.append(el("p", "viewer-notice", payload.notice));
  }

  return header;
}

function buildActions() {
  const actions = el("div", "viewer-actions");

  if (payload.sourceUrl) {
    const link = el("a", "viewer-action", "Originalseite ↗");
    link.href = payload.sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    actions.append(link);
  }

  if (payload.downloadUrl) {
    const link = el("a", "viewer-action", payload.converted ? "Originaldatei herunterladen" : "Herunterladen");
    link.href = payload.downloadUrl;
    actions.append(link);
  }

  return actions;
}

/* Panes ------------------------------------------------------------------- */

function buildPdfPane() {
  const pane = el("section", "viewer-pane");
  const toolbar = el("div", "pdf-toolbar");
  const shellEl = el("div", "pdf-shell");
  const container = el("div", "pdf-container");
  const viewerEl = el("div", "pdfViewer");
  container.append(viewerEl);
  shellEl.append(container);

  const previousButton = el("button", "pdf-button", "‹");
  previousButton.type = "button";
  previousButton.title = "Vorige Seite";
  const nextButton = el("button", "pdf-button", "›");
  nextButton.type = "button";
  nextButton.title = "Naechste Seite";
  const pageInput = el("input", "pdf-pageinput");
  pageInput.type = "text";
  pageInput.value = "1";
  pageInput.setAttribute("aria-label", "Seite");
  const pageInfo = el("span", "pdf-pageinfo", payload.pageCount ? `von ${payload.pageCount}` : "");

  const zoomOut = el("button", "pdf-button", "−");
  zoomOut.type = "button";
  zoomOut.title = "Verkleinern";
  const zoomIn = el("button", "pdf-button", "+");
  zoomIn.type = "button";
  zoomIn.title = "Vergroessern";
  const fitButton = el("button", "pdf-button", "Breite");
  fitButton.type = "button";
  fitButton.title = "An Breite oder Seite anpassen";

  const findWrap = el("div", "pdf-find");
  const findInput = el("input");
  findInput.type = "search";
  findInput.placeholder = "Im Dokument suchen";
  findInput.value = payload.query || "";
  const findPrevious = el("button", "pdf-button", "↑");
  findPrevious.type = "button";
  findPrevious.title = "Voriger Treffer";
  const findNext = el("button", "pdf-button", "↓");
  findNext.type = "button";
  findNext.title = "Naechster Treffer";
  const findCount = el("span", "pdf-findcount", "");
  findWrap.append(findInput, findPrevious, findNext, findCount);

  toolbar.append(previousButton, nextButton, pageInput, pageInfo, zoomOut, fitButton, zoomIn, findWrap);
  const status = el("div", "pdf-status", "Dokument wird geladen …");
  pane.append(toolbar, shellEl);
  shellEl.append(status);

  pane.ready = loadPdf({
    container,
    viewerEl,
    status,
    controls: { previousButton, nextButton, pageInput, pageInfo, zoomIn, zoomOut, fitButton, findInput, findPrevious, findNext, findCount }
  }).catch((error) => {
    status.textContent = `Die Seitenansicht liess sich nicht laden: ${error && error.message ? error.message : error}`;
    return null;
  });

  return pane;
}

async function loadPdf({ container, viewerEl, status, controls }) {
  const pdfjsLib = await import("/pdfjs/build/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.mjs";
  // Die Betrachter-Bausteine sind gegen die Bibliothek als globale Variable
  // uebersetzt und greifen beim Laden darauf zu. Ohne diese Zuweisung vor dem
  // Import bricht schon das Modul selbst ab.
  globalThis.pdfjsLib = pdfjsLib;
  const viewerComponents = await import("/pdfjs/web/pdf_viewer.mjs");

  const eventBus = new viewerComponents.EventBus();
  const linkService = new viewerComponents.PDFLinkService({ eventBus });
  const findController = new viewerComponents.PDFFindController({ eventBus, linkService });
  const pdfViewer = new viewerComponents.PDFViewer({
    container,
    viewer: viewerEl,
    eventBus,
    linkService,
    findController,
    textLayerMode: 2
  });
  linkService.setViewer(pdfViewer);

  const loadingTask = pdfjsLib.getDocument({
    url: payload.pdfUrl,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/"
  });

  const pdfDocument = await loadingTask.promise;
  status.remove();
  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, null);
  controls.pageInfo.textContent = `von ${pdfDocument.numPages}`;

  const phrase = highlightPhrase();
  let triedPhrase = false;

  const dispatchFind = (query, again, findPrevious) => {
    eventBus.dispatch("find", {
      source: window,
      type: again ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: Boolean(findPrevious),
      matchDiacritics: false
    });
  };

  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = "page-width";
    if (phrase) {
      triedPhrase = true;
      dispatchFind(phrase, false, false);
    } else if (payload.query) {
      dispatchFind(payload.query, false, false);
    }
  });

  eventBus.on("pagechanging", (event) => {
    controls.pageInput.value = String(event.pageNumber);
    controls.previousButton.disabled = event.pageNumber <= 1;
    controls.nextButton.disabled = event.pageNumber >= pdfDocument.numPages;
  });

  eventBus.on("updatefindmatchescount", (event) => {
    const total = event.matchesCount ? event.matchesCount.total : 0;
    const current = event.matchesCount ? event.matchesCount.current : 0;
    controls.findCount.textContent = total ? `${current}/${total}` : "";
  });

  eventBus.on("updatefindcontrolstate", (event) => {
    const total = event.matchesCount ? event.matchesCount.total : 0;
    if (total === 0 && triedPhrase && payload.query) {
      // Der angeklickte Ausschnitt stand so nicht im PDF - dann eben die
      // Suchbegriffe selbst.
      triedPhrase = false;
      dispatchFind(payload.query, false, false);
      return;
    }
    controls.findCount.textContent = total
      ? `${event.matchesCount.current}/${total}`
      : (controls.findInput.value ? "keine Treffer" : "");
  });

  controls.previousButton.addEventListener("click", () => {
    pdfViewer.currentPageNumber = Math.max(1, pdfViewer.currentPageNumber - 1);
  });
  controls.nextButton.addEventListener("click", () => {
    pdfViewer.currentPageNumber = Math.min(pdfDocument.numPages, pdfViewer.currentPageNumber + 1);
  });
  controls.pageInput.addEventListener("change", () => {
    const requested = Number(controls.pageInput.value);
    if (Number.isFinite(requested) && requested >= 1 && requested <= pdfDocument.numPages) {
      pdfViewer.currentPageNumber = requested;
    } else {
      controls.pageInput.value = String(pdfViewer.currentPageNumber);
    }
  });
  controls.zoomIn.addEventListener("click", () => {
    pdfViewer.currentScale = Math.min(pdfViewer.currentScale * 1.2, 6);
  });
  controls.zoomOut.addEventListener("click", () => {
    pdfViewer.currentScale = Math.max(pdfViewer.currentScale / 1.2, 0.2);
  });
  controls.fitButton.addEventListener("click", () => {
    const fitsWidth = pdfViewer.currentScaleValue === "page-width";
    pdfViewer.currentScaleValue = fitsWidth ? "page-fit" : "page-width";
    controls.fitButton.textContent = fitsWidth ? "Seite" : "Breite";
  });

  let findDebounce = 0;
  controls.findInput.addEventListener("input", () => {
    window.clearTimeout(findDebounce);
    findDebounce = window.setTimeout(() => {
      triedPhrase = false;
      dispatchFind(controls.findInput.value, false, false);
    }, 220);
  });
  controls.findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dispatchFind(controls.findInput.value, true, event.shiftKey);
    }
  });
  controls.findPrevious.addEventListener("click", () => dispatchFind(controls.findInput.value, true, true));
  controls.findNext.addEventListener("click", () => dispatchFind(controls.findInput.value, true, false));

  // Viele PDFs bringen ihre eigene Gliederung mit. Die ist jeder abgeleiteten
  // Abschnittsliste ueberlegen, weil sie vom Autor stammt.
  const outline = await pdfDocument.getOutline().catch(() => null);

  return { pdfViewer, eventBus, dispatchFind, linkService, outline: outline || [] };
}

function buildWebpagePane() {
  const pane = el("section", "viewer-pane");
  const iframe = document.createElement("iframe");
  iframe.className = "viewer-iframe";
  // Weder allow-scripts noch allow-same-origin: der Rahmen zeigt fremdes,
  // gecrawltes HTML. Zusammen heben diese beiden Werte die Sandbox gegenseitig
  // auf - der Inhalt koennte dann auf das RAGfind-Dokument zugreifen. Ohne sie
  // bekommt der Rahmen einen eigenen, leeren Ursprung und fuehrt nichts aus;
  // Stylesheets, Bilder und Schriften laedt er weiterhin.
  iframe.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.src = payload.pageUrl;
  pane.append(iframe);
  return pane;
}

function buildImagePane() {
  const pane = el("section", "viewer-pane");
  const shellEl = el("div", "image-shell");
  const image = document.createElement("img");
  image.src = payload.mediaUrl;
  image.alt = payload.title;
  shellEl.append(image);
  pane.append(shellEl);
  return pane;
}

function buildMediaPane() {
  const pane = el("section", "viewer-pane");
  const shellEl = el("div", "media-shell");
  const media = document.createElement(payload.presentation === "audio" ? "audio" : "video");
  media.src = payload.mediaUrl;
  media.controls = true;
  shellEl.append(media);
  pane.append(shellEl);
  return pane;
}

function buildRenderedPane() {
  const pane = el("section", "viewer-pane");
  const content = el("div", `viewer-content ${payload.presentation}`);
  content.innerHTML = payload.renderedHtml;
  pane.append(content);
  return pane;
}

function buildDownloadPane() {
  const pane = el("section", "viewer-pane");
  const card = el("div", "download-card");
  card.append(el("strong", null, "Für dieses Format gibt es keine Vorschau."));
  card.append(el("span", null, [payload.originalName, payload.fileType ? `.${payload.fileType}` : null, formatBytes(payload.fileSizeBytes)].filter(Boolean).join(" · ")));
  if (payload.downloadUrl) {
    const link = el("a", "viewer-action", "Datei herunterladen");
    link.href = payload.downloadUrl;
    card.append(document.createElement("br"), link);
  }
  pane.append(card);
  return pane;
}

// Textfassung mit eigener Suche: die Begriffe der Anfrage sind markiert, und
// man kann von Treffer zu Treffer springen.
function buildTextPane(text) {
  const pane = el("section", "viewer-pane");
  const findbar = el("div", "viewer-findbar");
  const input = el("input");
  input.type = "search";
  input.placeholder = "Im Text suchen";
  input.value = payload.query || "";
  const previousButton = el("button", "pdf-button", "↑");
  previousButton.type = "button";
  const nextButton = el("button", "pdf-button", "↓");
  nextButton.type = "button";
  const counter = el("span", "pdf-findcount", "");
  findbar.append(input, previousButton, nextButton, counter);

  const content = el("div", "viewer-content");
  const pre = el("pre", "viewer-text");
  content.append(pre);
  pane.append(findbar, content);

  let marks = [];
  let currentIndex = -1;

  const render = (terms) => {
    const built = buildHighlightedFragment(text, terms);
    pre.replaceChildren(built.fragment);
    marks = built.marks;
    currentIndex = marks.length > 0 ? 0 : -1;
    counter.textContent = marks.length ? `1/${marks.length}` : (terms.length ? "keine Treffer" : "");
    if (marks.length > 0) {
      marks[0].dataset.current = "true";
      marks[0].scrollIntoView({ block: "center" });
    }
  };

  const step = (delta) => {
    if (marks.length === 0) {
      return;
    }
    if (currentIndex >= 0) {
      delete marks[currentIndex].dataset.current;
    }
    currentIndex = (currentIndex + delta + marks.length) % marks.length;
    marks[currentIndex].dataset.current = "true";
    marks[currentIndex].scrollIntoView({ block: "center" });
    counter.textContent = `${currentIndex + 1}/${marks.length}`;
  };

  const termsFromInput = () => [...new Set(
    input.value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((term) => term.length >= 2)
  )];

  let debounce = 0;
  input.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => render(termsFromInput()), 220);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  });
  previousButton.addEventListener("click", () => step(-1));
  nextButton.addEventListener("click", () => step(1));

  render(queryTerms());

  pane.scrollToText = (needle) => {
    const index = text.toLowerCase().indexOf(needle.toLowerCase());
    if (index < 0) {
      return false;
    }
    input.value = needle.split(/\s+/).slice(0, 6).join(" ");
    render([input.value]);
    return true;
  };

  return pane;
}

function buildSectionsPane(onJump) {
  const pane = el("section", "viewer-pane");
  const list = el("ul", "section-list");

  for (const section of payload.sections) {
    const item = document.createElement("li");
    const button = el("button", "section-link");
    button.type = "button";
    button.append(el("span", "section-link__title", section.title));
    if (section.preview) {
      button.append(el("span", "section-link__preview", section.preview));
    }
    button.addEventListener("click", () => onJump(section));
    item.append(button);
    list.append(item);
  }

  pane.append(list);
  return pane;
}

function buildOutlinePane(api) {
  const pane = el("section", "viewer-pane");
  const list = el("ul", "section-list");

  const appendItems = (items, depth) => {
    for (const item of items) {
      const entry = document.createElement("li");
      const button = el("button", "section-link");
      button.type = "button";
      button.style.paddingLeft = `${0.8 + depth * 1.1}rem`;
      button.append(el("span", "section-link__title", item.title));
      button.addEventListener("click", () => {
        if (item.dest) {
          api.linkService.goToDestination(item.dest);
        }
      });
      entry.append(button);
      list.append(entry);

      if (Array.isArray(item.items) && item.items.length > 0) {
        appendItems(item.items, depth + 1);
      }
    }
  };

  appendItems(api.outline, 0);
  pane.append(list);
  return pane;
}

function buildInfoPane() {
  const pane = el("section", "viewer-pane");
  const grid = el("dl", "info-grid");

  const rows = [
    ["Titel", payload.title],
    ["Quelle", payload.sourceRef],
    ["Herkunft", payload.sourceType],
    ["Wissensdatenbank", payload.knowledgeBaseName],
    ["Dokumenttyp", documentTypeLabel(payload.documentType)],
    ["Dateityp", payload.fileType ? `.${payload.fileType}` : null],
    ["MIME-Typ", payload.mimeType],
    ["Seiten", payload.pageCount ? String(payload.pageCount) : null],
    ["Groesse", formatBytes(payload.fileSizeBytes)],
    ["Dateiname", payload.originalName],
    ["Aufgenommen", formatDate(payload.createdAt)],
    ["Aktualisiert", formatDate(payload.updatedAt)],
    ["Zusammenfassung", payload.summary]
  ].filter(([, value]) => Boolean(value));

  for (const [label, value] of rows) {
    grid.append(el("dt", null, label));
    grid.append(el("dd", null, value));
  }

  pane.append(grid);
  return pane;
}

/* Zusammenbau ------------------------------------------------------------- */

function build() {
  applyStoredTheme();

  const toolbar = el("div", "viewer-toolbar");
  const tabsEl = el("div", "viewer-tabs");
  toolbar.append(tabsEl, buildActions());

  const body = el("div", "viewer-body");
  const tabs = [];

  const addTab = (id, label, pane) => {
    const button = el("button", "viewer-tab", label);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    button.addEventListener("click", () => activate(id));
    tabsEl.append(button);
    body.append(pane);
    tabs.push({ id, button, pane });
    return pane;
  };

  const activate = (id) => {
    for (const tab of tabs) {
      const active = tab.id === id;
      tab.button.setAttribute("aria-selected", String(active));
      tab.pane.dataset.active = String(active);
    }
  };

  let viewPane = null;
  if (payload.presentation === "pdf") {
    viewPane = addTab("view", "Seitenansicht", buildPdfPane());
  } else if (payload.presentation === "webpage") {
    viewPane = addTab("view", "Seite", buildWebpagePane());
  } else if (payload.presentation === "image") {
    viewPane = addTab("view", "Bild", buildImagePane());
  } else if (payload.presentation === "audio" || payload.presentation === "video") {
    viewPane = addTab("view", "Wiedergabe", buildMediaPane());
  } else if (payload.presentation === "binary") {
    viewPane = addTab("view", "Datei", buildDownloadPane());
  } else {
    viewPane = addTab("view", payload.presentation === "code" ? "Quelltext" : payload.presentation === "markdown" ? "Dokument" : "Text", buildRenderedPane());
  }

  // Der Texttab lohnt nur, wo die Ansicht etwas anderes zeigt als den Text.
  const showTextTab = payload.rawText.trim().length > 0
    && !["text", "markdown", "code"].includes(payload.presentation);
  const textPane = showTextTab ? addTab("text", "Text", buildTextPane(payload.rawText)) : null;

  if (payload.sections.length > 1) {
    addTab("sections", `Abschnitte (${payload.sections.length})`, buildSectionsPane((section) => {
      if (payload.presentation === "pdf") {
        // Im PDF ist die Ueberschrift der zuverlaessigste Anker: Seitenzahlen
        // stehen bei dieser Ingestion nicht an den Abschnitten.
        activate("view");
        const findInput = viewPane.querySelector(".pdf-find input");
        if (findInput) {
          findInput.value = section.title;
          findInput.dispatchEvent(new Event("input"));
        }
        return;
      }

      if (textPane && textPane.scrollToText && textPane.scrollToText(section.title)) {
        activate("text");
        return;
      }

      activate("view");
      const target = [...viewPane.querySelectorAll("h1, h2, h3, h4")]
        .find((heading) => heading.textContent.trim().startsWith(section.title.slice(0, 40)));
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    }));
  }

  addTab("info", "Details", buildInfoPane());
  activate("view");

  // Die Gliederung steht erst fest, wenn das PDF geladen ist. Liegt eine vor,
  // ersetzt sie die abgeleiteten Abschnitte - oder kommt als eigener Tab dazu,
  // wenn es gar keine gab.
  if (viewPane.ready) {
    viewPane.ready.then((api) => {
      if (!api || !api.outline || api.outline.length === 0) {
        return;
      }

      const outlinePane = buildOutlinePane(api);
      const existing = tabs.find((tab) => tab.id === "sections");
      if (existing) {
        existing.pane.replaceWith(outlinePane);
        outlinePane.dataset.active = existing.pane.dataset.active || "false";
        existing.pane = outlinePane;
        existing.button.textContent = "Inhalt";
        return;
      }

      const button = el("button", "viewer-tab", "Inhalt");
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", "false");
      button.addEventListener("click", () => activate("outline"));
      tabsEl.insertBefore(button, tabsEl.lastElementChild);
      body.append(outlinePane);
      outlinePane.dataset.active = "false";
      tabs.push({ id: "outline", button, pane: outlinePane });
    });
  }

  const header = buildHeader();
  header.append(toolbar);
  shell.append(buildTopbar(), header, body);

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      const input = document.querySelector('.viewer-pane[data-active="true"] input[type="search"]');
      if (input) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    }
  });
}

build();
