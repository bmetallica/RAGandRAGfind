const RESULTS_PAGE_SIZE = 10;
const RECENT_SEARCHES_KEY = "ragfind-recent";
const RECENT_SEARCHES_MAX = 8;

const state = {
  theme: localStorage.getItem("ragfind-theme") || "system",
  scopeLabel: "",
  payload: null,
  filters: { documentType: new Set(), knowledgeBase: new Set(), fileType: new Set() },
  sort: "relevance",
  visibleCount: RESULTS_PAGE_SIZE,
  selectedIndex: -1
};

const themeToggleEl = document.getElementById("theme-toggle");
const heroViewEl = document.getElementById("hero-view");
const resultsViewEl = document.getElementById("results-view");
const scopeNoteEl = document.getElementById("scope-note");
const searchFormEl = document.getElementById("search-form");
const resultsSearchFormEl = document.getElementById("results-search-form");
const searchInputEl = document.getElementById("search-input");
const resultsSearchInputEl = document.getElementById("results-search-input");
const resultsMetaEl = document.getElementById("results-meta");
const resultsListEl = document.getElementById("results-list");
const resultsFiltersEl = document.getElementById("results-filters");
const resultsSuggestionEl = document.getElementById("results-suggestion");
const resultsMoreEl = document.getElementById("results-more");
const loadMoreEl = document.getElementById("load-more");
const emptyStateEl = document.getElementById("empty-state");
const recentSearchesEl = document.getElementById("recent-searches");

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

const PREVIEW_ICONS = {
  pdf: "PDF",
  webpage: "WEB",
  image: "BILD",
  audio: "AUDIO",
  video: "VIDEO",
  markdown: "MD",
  code: "CODE",
  text: "TXT",
  binary: "DATEI"
};

const FACET_FIELDS = [
  { key: "documentTypes", filter: "documentType", label: "Dokumenttyp", accessor: (result) => result.documentType, format: (value) => DOCUMENT_TYPE_LABELS[value] || value },
  { key: "knowledgeBases", filter: "knowledgeBase", label: "Wissensdatenbank", accessor: (result) => result.knowledgeBaseName, format: (value) => value },
  { key: "fileTypes", filter: "fileType", label: "Dateityp", accessor: (result) => result.fileType, format: (value) => `.${value}` }
];

function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem("ragfind-theme", theme);
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
  document.body.dataset.theme = resolved;
}

function toggleTheme() {
  if (state.theme === "light") {
    setTheme("dark");
    return;
  }
  if (state.theme === "dark") {
    setTheme("system");
    return;
  }
  setTheme("light");
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
  if (bytes === null || bytes === undefined) {
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

async function requestJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `request failed with status ${response.status}`);
  }
  return payload;
}

function renderScopeLabel(meta) {
  const names = Array.isArray(meta?.knowledgeBases)
    ? meta.knowledgeBases.map((knowledgeBase) => knowledgeBase.name).filter(Boolean)
    : [];
  state.scopeLabel = names.length
    ? `Suche nur in: ${names.join(", ")}`
    : "Suche nur in den fuer RAGfind konfigurierten Wissensdatenbanken";
  scopeNoteEl.textContent = state.scopeLabel;
}

/* Zuletzt gesucht ---------------------------------------------------------- */

function readRecentSearches() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function rememberSearch(query) {
  const entries = [query, ...readRecentSearches().filter((entry) => entry !== query)].slice(0, RECENT_SEARCHES_MAX);
  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(entries));
  } catch {
    // Speichern ist Komfort, kein Muss - ein voller oder gesperrter Speicher
    // darf die Suche nicht anhalten.
  }
}

function renderRecentSearches() {
  const entries = readRecentSearches();
  recentSearchesEl.replaceChildren();
  if (entries.length === 0) {
    recentSearchesEl.classList.add("hidden");
    return;
  }

  recentSearchesEl.classList.remove("hidden");
  recentSearchesEl.append(el("span", "recent-searches__label", "Zuletzt gesucht"));
  for (const entry of entries) {
    const chip = el("button", "chip", entry);
    chip.type = "button";
    chip.addEventListener("click", () => {
      searchInputEl.value = entry;
      void runSearch(entry, { push: true });
    });
    recentSearchesEl.append(chip);
  }
}

/* Trefferliste ------------------------------------------------------------- */

function visibleResults() {
  if (!state.payload) {
    return [];
  }

  const filtered = state.payload.results.filter((result) => {
    for (const field of FACET_FIELDS) {
      const selected = state.filters[field.filter];
      if (selected.size > 0 && !selected.has(field.accessor(result) || "")) {
        return false;
      }
    }
    return true;
  });

  if (state.sort === "date") {
    return filtered.sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0));
  }
  return filtered;
}

function buildThumb(result) {
  const link = el("a", "result-thumb");
  link.href = result.viewUrl;

  if (result.thumbUrl) {
    const image = document.createElement("img");
    image.loading = "lazy";
    image.alt = "";
    image.src = result.thumbUrl;
    // Ohne erzeugbares Vorschaubild bleibt das Kuerzel stehen statt eines
    // kaputten Bildsymbols.
    image.addEventListener("error", () => {
      link.replaceChildren(el("span", "result-thumb__badge", PREVIEW_ICONS[result.previewKind] || "DOK"));
    });
    link.append(image);
  } else {
    link.append(el("span", "result-thumb__badge", PREVIEW_ICONS[result.previewKind] || "DOK"));
  }

  return link;
}

function buildResultCard(result, index) {
  const card = el("article", "result-card");
  card.dataset.index = String(index);
  card.append(buildThumb(result));

  const body = el("div", "result-body");

  const kickerParts = [
    DOCUMENT_TYPE_LABELS[result.documentType] || result.documentType,
    result.knowledgeBaseName,
    result.sourceType
  ].filter(Boolean);
  body.append(el("div", "result-kicker", kickerParts.join(" · ")));

  const title = el("a", "result-title", result.title);
  title.href = result.viewUrl;
  body.append(title);

  const metaParts = [
    result.originalName || result.sourceRef,
    result.fileType ? `.${result.fileType}` : null,
    formatBytes(result.fileSizeBytes),
    formatDate(result.updatedAt)
  ].filter(Boolean);
  body.append(el("div", "result-source", metaParts.join(" · ")));

  if (result.summary) {
    body.append(el("p", "result-summary", result.summary));
  }

  for (const snippet of result.snippets) {
    const snippetLink = document.createElement("a");
    snippetLink.className = "result-snippet";
    const params = new URLSearchParams();
    if (state.payload.query) {
      params.set("q", state.payload.query);
    }
    if (snippet.text) {
      params.set("hl", snippet.text.slice(0, 400));
    }
    snippetLink.href = `/view/${result.documentId}?${params.toString()}`;
    // Der Ausschnitt kommt vom Server bereits entschaerft, mit <mark> um die
    // Suchbegriffe.
    snippetLink.innerHTML = snippet.snippet;
    body.append(snippetLink);

    const snippetMetaParts = [];
    if (snippet.sectionTitle) {
      snippetMetaParts.push(`Abschnitt: ${snippet.sectionTitle}`);
    } else if (snippet.sectionIndex !== null) {
      snippetMetaParts.push(`Abschnitt #${snippet.sectionIndex}`);
    }
    if (snippet.pageStart !== null) {
      snippetMetaParts.push(`Seite ${snippet.pageStart}${snippet.pageEnd && snippet.pageEnd !== snippet.pageStart ? `-${snippet.pageEnd}` : ""}`);
    }
    if (snippetMetaParts.length > 0) {
      body.append(el("div", "snippet-meta", snippetMetaParts.join(" | ")));
    }
  }

  if (result.snippets.length > 1) {
    body.append(el("div", "snippet-meta", `${result.snippets.length} Fundstellen in diesem Dokument`));
  }

  card.append(body);
  return card;
}

function renderFilters() {
  resultsFiltersEl.replaceChildren();
  const facets = state.payload?.facets;
  if (!facets) {
    resultsFiltersEl.classList.add("hidden");
    return;
  }

  const groups = FACET_FIELDS
    .map((field) => ({ field, entries: facets[field.key] || [] }))
    .filter((group) => group.entries.length > 1);

  const sortGroup = el("div", "filter-group");
  sortGroup.append(el("h2", "filter-group__title", "Sortierung"));
  for (const [value, label] of [["relevance", "Relevanz"], ["date", "Neueste zuerst"]]) {
    const button = el("button", "chip", label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(state.sort === value));
    button.addEventListener("click", () => {
      state.sort = value;
      renderResultList();
      renderFilters();
    });
    sortGroup.append(button);
  }
  resultsFiltersEl.append(sortGroup);

  for (const { field, entries } of groups) {
    const group = el("div", "filter-group");
    group.append(el("h2", "filter-group__title", field.label));
    for (const entry of entries) {
      const active = state.filters[field.filter].has(entry.value);
      const button = el("button", "chip", `${field.format(entry.value)} (${entry.count})`);
      button.type = "button";
      button.setAttribute("aria-pressed", String(active));
      button.addEventListener("click", () => {
        const selected = state.filters[field.filter];
        if (selected.has(entry.value)) {
          selected.delete(entry.value);
        } else {
          selected.add(entry.value);
        }
        state.visibleCount = RESULTS_PAGE_SIZE;
        renderResultList();
        renderFilters();
        writeUrl(state.payload.query, { replace: true });
      });
      group.append(button);
    }
    resultsFiltersEl.append(group);
  }

  const hasActiveFilter = FACET_FIELDS.some((field) => state.filters[field.filter].size > 0);
  if (hasActiveFilter) {
    const reset = el("button", "chip chip--reset", "Filter zurücksetzen");
    reset.type = "button";
    reset.addEventListener("click", () => {
      for (const field of FACET_FIELDS) {
        state.filters[field.filter].clear();
      }
      state.visibleCount = RESULTS_PAGE_SIZE;
      renderResultList();
      renderFilters();
      writeUrl(state.payload.query, { replace: true });
    });
    resultsFiltersEl.append(reset);
  }

  resultsFiltersEl.classList.toggle("hidden", resultsFiltersEl.childElementCount === 0);
}

function renderResultList() {
  const results = visibleResults();
  const shown = results.slice(0, state.visibleCount);

  resultsListEl.replaceChildren();
  for (const [index, result] of shown.entries()) {
    resultsListEl.append(buildResultCard(result, index));
  }

  const payload = state.payload;
  const scopeNames = (payload.searchScope?.knowledgeBaseNames || []).join(", ");
  const filteredNote = results.length !== payload.results.length ? ` (aus ${payload.results.length})` : "";
  resultsMetaEl.textContent = `${results.length} Dokumenttreffer${filteredNote} in ${payload.tookMs} ms${payload.cached ? " (aus dem Zwischenspeicher)" : ""}. Suchbereich: ${scopeNames}.`;

  resultsMoreEl.classList.toggle("hidden", shown.length >= results.length);
  emptyStateEl.classList.toggle("hidden", results.length > 0);
  if (results.length === 0) {
    emptyStateEl.textContent = payload.results.length === 0
      ? `Keine Treffer für „${payload.query}“ in den fuer RAGfind konfigurierten Wissensdatenbanken.`
      : "Keine Treffer mit diesen Filtern.";
  }

  state.selectedIndex = -1;
}

function renderSuggestion() {
  const suggestion = state.payload?.suggestion;
  if (!suggestion) {
    resultsSuggestionEl.classList.add("hidden");
    return;
  }

  resultsSuggestionEl.classList.remove("hidden");
  resultsSuggestionEl.replaceChildren(document.createTextNode("Meintest du "));
  const link = el("button", "link-button", suggestion);
  link.type = "button";
  link.addEventListener("click", () => {
    resultsSearchInputEl.value = suggestion;
    void runSearch(suggestion, { push: true });
  });
  resultsSuggestionEl.append(link, document.createTextNode("?"));
}

function showLoading(query) {
  heroViewEl.classList.add("hidden");
  resultsViewEl.classList.remove("hidden");
  document.querySelector(".page-shell").dataset.view = "results";
  resultsSearchInputEl.value = query;
  resultsSuggestionEl.classList.add("hidden");
  resultsMoreEl.classList.add("hidden");
  emptyStateEl.classList.add("hidden");
  resultsFiltersEl.classList.add("hidden");
  resultsMetaEl.textContent = "Suche läuft …";

  resultsListEl.replaceChildren();
  for (let index = 0; index < 4; index += 1) {
    const skeleton = el("article", "result-card result-card--skeleton");
    skeleton.append(el("div", "result-thumb skeleton-block"));
    const body = el("div", "result-body");
    body.append(el("div", "skeleton-line skeleton-line--short"));
    body.append(el("div", "skeleton-line skeleton-line--title"));
    body.append(el("div", "skeleton-line"));
    body.append(el("div", "skeleton-line"));
    skeleton.append(body);
    resultsListEl.append(skeleton);
  }
}

function showHome() {
  heroViewEl.classList.remove("hidden");
  resultsViewEl.classList.add("hidden");
  document.querySelector(".page-shell").dataset.view = "home";
  resultsListEl.replaceChildren();
  emptyStateEl.classList.add("hidden");
  renderRecentSearches();
}

function renderPayload(payload) {
  state.payload = payload;
  heroViewEl.classList.add("hidden");
  resultsViewEl.classList.remove("hidden");
  document.querySelector(".page-shell").dataset.view = "results";
  resultsSearchInputEl.value = payload.query;
  renderSuggestion();
  renderResultList();
  renderFilters();
}

/* Adresse, Verlauf und Zwischenspeicher ------------------------------------ */

function filtersToParams(params) {
  for (const field of FACET_FIELDS) {
    const selected = [...state.filters[field.filter]];
    if (selected.length > 0) {
      params.set(field.filter, selected.join("|"));
    }
  }
  return params;
}

function writeUrl(query, options = {}) {
  const params = filtersToParams(new URLSearchParams({ q: query }));
  const url = `${location.pathname}?${params.toString()}`;
  if (options.replace) {
    history.replaceState({ query }, "", url);
  } else {
    history.pushState({ query }, "", url);
  }
}

function readFiltersFromUrl(url) {
  for (const field of FACET_FIELDS) {
    state.filters[field.filter].clear();
    const raw = url.searchParams.get(field.filter);
    if (raw) {
      for (const value of raw.split("|").filter(Boolean)) {
        state.filters[field.filter].add(value);
      }
    }
  }
}

// Zurueck aus der Dokumentansicht soll die Liste sofort zeigen, nicht erneut
// mehrere Sekunden suchen.
function cachePayload(payload) {
  try {
    sessionStorage.setItem(`ragfind-result:${payload.query.toLowerCase()}`, JSON.stringify(payload));
  } catch {
    // Zwischenspeichern ist Komfort; ein voller Speicher darf nichts brechen.
  }
}

function readCachedPayload(query) {
  try {
    const raw = sessionStorage.getItem(`ragfind-result:${query.toLowerCase()}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function runSearch(query, options = {}) {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length < 2) {
    return;
  }

  state.visibleCount = RESULTS_PAGE_SIZE;
  if (!options.keepFilters) {
    for (const field of FACET_FIELDS) {
      state.filters[field.filter].clear();
    }
  }

  const cached = options.allowCache === false ? null : readCachedPayload(trimmedQuery);
  if (cached) {
    renderPayload(cached);
    if (options.push) {
      writeUrl(trimmedQuery);
    } else if (options.replace !== false) {
      writeUrl(trimmedQuery, { replace: true });
    }
    return;
  }

  showLoading(trimmedQuery);
  try {
    const payload = await requestJson(`/api/search?q=${encodeURIComponent(trimmedQuery)}`);
    renderPayload(payload);
    cachePayload(payload);
    rememberSearch(trimmedQuery);
    if (options.push) {
      writeUrl(trimmedQuery);
    } else {
      writeUrl(trimmedQuery, { replace: true });
    }
  } catch (error) {
    resultsMetaEl.textContent = "";
    resultsListEl.replaceChildren();
    resultsFiltersEl.classList.add("hidden");
    emptyStateEl.classList.remove("hidden");
    emptyStateEl.textContent = error instanceof Error ? error.message : "Suche fehlgeschlagen.";
  }
}

/* Tastatur ----------------------------------------------------------------- */

function moveSelection(delta) {
  const cards = [...resultsListEl.querySelectorAll(".result-card:not(.result-card--skeleton)")];
  if (cards.length === 0) {
    return;
  }

  if (state.selectedIndex >= 0 && cards[state.selectedIndex]) {
    cards[state.selectedIndex].classList.remove("result-card--selected");
  }
  state.selectedIndex = Math.min(Math.max(state.selectedIndex + delta, 0), cards.length - 1);
  const selected = cards[state.selectedIndex];
  selected.classList.add("result-card--selected");
  selected.scrollIntoView({ block: "nearest" });
}

function openSelection() {
  const cards = [...resultsListEl.querySelectorAll(".result-card:not(.result-card--skeleton)")];
  const selected = cards[state.selectedIndex];
  const link = selected?.querySelector(".result-title");
  if (link) {
    location.href = link.href;
  }
}

function bindKeyboard() {
  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);

    if (event.key === "/" && !typing) {
      event.preventDefault();
      const input = resultsViewEl.classList.contains("hidden") ? searchInputEl : resultsSearchInputEl;
      input.focus();
      input.select();
      return;
    }

    if (typing || resultsViewEl.classList.contains("hidden")) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter") {
      openSelection();
    }
  });
}

async function initialize() {
  setTheme(state.theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") {
      setTheme("system");
    }
  });

  themeToggleEl.addEventListener("click", toggleTheme);
  loadMoreEl.addEventListener("click", () => {
    state.visibleCount += RESULTS_PAGE_SIZE;
    renderResultList();
  });

  const onSubmit = (event, input) => {
    event.preventDefault();
    void runSearch(input.value, { push: true, allowCache: false });
  };
  searchFormEl.addEventListener("submit", (event) => onSubmit(event, searchInputEl));
  resultsSearchFormEl.addEventListener("submit", (event) => onSubmit(event, resultsSearchInputEl));

  window.addEventListener("popstate", () => {
    const url = new URL(window.location.href);
    const query = url.searchParams.get("q");
    readFiltersFromUrl(url);
    if (query) {
      void runSearch(query, { keepFilters: true, replace: false });
    } else {
      showHome();
    }
  });

  bindKeyboard();
  renderRecentSearches();

  const url = new URL(window.location.href);
  const initialQuery = url.searchParams.get("q");
  readFiltersFromUrl(url);
  if (initialQuery) {
    searchInputEl.value = initialQuery;
    await runSearch(initialQuery, { keepFilters: true });
  } else {
    showHome();
  }

  // Der Suchbereich ist Beiwerk und darf die Trefferliste nicht aufhalten.
  requestJson("/api/meta").then(renderScopeLabel).catch(() => {
    scopeNoteEl.textContent = "Suchbereich konnte nicht geladen werden.";
  });
}

void initialize();
