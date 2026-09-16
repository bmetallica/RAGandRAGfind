const statsEl = document.getElementById("stats");
const statusBadgeEl = document.getElementById("status-badge");
const embeddingProgressPanelEl = document.getElementById("embedding-progress-panel");
const embeddingProgressSummaryEl = document.getElementById("embedding-progress-summary");
const embeddingProgressBarEl = document.getElementById("embedding-progress-bar");
const embeddingProgressFailedEl = document.getElementById("embedding-progress-failed");
const configEl = document.getElementById("config");
const jobsEl = document.getElementById("jobs");
const jobsPaginationEl = document.getElementById("jobs-pagination");
const documentsEl = document.getElementById("documents");
const documentsPaginationEl = document.getElementById("documents-pagination");
const documentsSummaryEl = document.getElementById("documents-summary");
const knowledgeBasesEl = document.getElementById("knowledge-bases");
const knowledgeBaseFormEl = document.getElementById("knowledge-base-form");
const knowledgeBaseResetEl = document.getElementById("knowledge-base-reset");
const mcpPrincipalsEl = document.getElementById("mcp-principals");
const mcpPrincipalFormEl = document.getElementById("mcp-principal-form");
const mcpPrincipalResetEl = document.getElementById("mcp-principal-reset");
const principalKnowledgeBaseOptionsEl = document.getElementById("principal-knowledge-base-options");
const importKnowledgeBaseSelectEls = [...document.querySelectorAll("[data-knowledge-base-select]")];
// Remember an explicit pick so re-rendering the options (after a knowledge base
// was created, renamed or deleted) does not reset the select.
importKnowledgeBaseSelectEls.forEach((select) => {
  select.addEventListener("change", () => {
    select.dataset.knowledgeBaseTouched = "true";
  });
});
const documentTypeSelectEls = [...document.querySelectorAll("[data-document-type-select]")];
const categorySelectEls = [...document.querySelectorAll("[data-category-select]")];
const sourceTypeSelectEls = [...document.querySelectorAll("[data-source-type-select]")];
const mcpTokenOutputEl = document.getElementById("mcp-token-output");
const settingsToggleEl = document.getElementById("settings-toggle");
const adminAccessToggleEl = document.getElementById("admin-access-toggle");
const viewNavButtons = [...document.querySelectorAll("[data-view]")];
const viewPanelEls = [...document.querySelectorAll("[data-view-panel]")];
const adminPasswordFormEl = document.getElementById("admin-password-form");
const adminUserFormEl = document.getElementById("admin-user-form");
const adminUsersEl = document.getElementById("admin-users");
const elasticsearchAdminStatusEl = document.getElementById("elasticsearch-admin-status");
const elasticsearchReindexEl = document.getElementById("elasticsearch-reindex");
const forceReembedEl = document.getElementById("embeddings-force-reembed");
const classificationAdminStatusEl = document.getElementById("classification-admin-status");
const classificationReindexEl = document.getElementById("classification-reindex");
const documentTypeSettingsEl = document.getElementById("document-type-settings");
const ragfindKnowledgeBaseOptionsEl = document.getElementById("ragfind-knowledge-base-options");
const ragfindSettingsFormEl = document.getElementById("ragfind-settings-form");
const ragfindSettingsSummaryEl = document.getElementById("ragfind-settings-summary");
const gitImportAdminStatusEl = document.getElementById("git-import-admin-status");
const aiProviderSettingsFormEl = document.getElementById("ai-provider-settings-form");
const aiProviderSelectEl = document.getElementById("ai-provider-select");
const aiProviderBaseUrlEl = document.getElementById("ai-provider-base-url");
const aiProviderApiKeyFieldEl = document.getElementById("ai-provider-api-key-field");
const aiProviderApiKeyEl = document.getElementById("ai-provider-api-key");
const aiProviderApiKeyHintEl = document.getElementById("ai-provider-api-key-hint");
const aiProviderLoadModelsEl = document.getElementById("ai-provider-load-models");
const aiProviderReachabilityEl = document.getElementById("ai-provider-reachability");
const aiProviderEmbeddingModelEl = document.getElementById("ai-provider-embedding-model");
const aiProviderSummaryModelEl = document.getElementById("ai-provider-summary-model");
const aiProviderClassifierModelEl = document.getElementById("ai-provider-classifier-model");
const aiProviderEmbeddingDimensionEl = document.getElementById("ai-provider-embedding-dimension");
const rerankerEnabledEl = document.getElementById("reranker-enabled");
const rerankerBaseUrlEl = document.getElementById("reranker-base-url");
const rerankerModelEl = document.getElementById("reranker-model");
const rerankerTopNEl = document.getElementById("reranker-top-n");
const rerankerStatusEl = document.getElementById("reranker-status");
const apiKeyClearRowEl = document.getElementById("ai-provider-api-key-clear-row");
const apiKeyClearEl = document.getElementById("ai-provider-api-key-clear");
const aiProviderSettingsSummaryEl = document.getElementById("ai-provider-settings-summary");
const documentPreviewEl = document.getElementById("document-preview");
const documentPreviewFormEl = document.getElementById("document-preview-form");
const documentFiltersFormEl = document.getElementById("document-filters-form");
const documentAnalysisEl = document.getElementById("document-analysis");
const schedulesEl = document.getElementById("schedules");
const queryResultEl = document.getElementById("query-result");
const toastEl = document.getElementById("toast");
const themeToggleEl = document.getElementById("theme-toggle");
const analysisButtons = [...document.querySelectorAll("[data-analysis]")];

const state = {
  selectedDocumentId: null,
  jobs: [],
  documents: [],
  knowledgeBases: [],
  mcpPrincipals: [],
  adminUsers: [],
  documentTypeSettings: [],
  ragfindSettings: {
    knowledgeBaseIds: [],
    knowledgeBases: [],
    updatedAt: null
  },
  aiProviderSettings: {
    provider: "ollama",
    baseUrl: "",
    apiKeySet: false,
    embeddingModel: "",
    summaryModel: "",
    classifierModel: "",
    embeddingDimension: null,
    updatedAt: null
  },
  aiProviderModels: [],
  jobsPage: 1,
  documentsPage: 1,
  pageSize: 5,
  editingKnowledgeBaseId: null,
  editingPrincipalId: null,
  filters: {
    query: "",
    category: "",
    sourceType: "",
    documentType: "",
    limit: 25
  },
  status: null
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatJson(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function getClassificationInfo(source) {
  const metadata = source?.metadata ?? source ?? {};
  const classification = metadata.classification && typeof metadata.classification === "object"
    ? metadata.classification
    : null;

  return {
    documentType: typeof metadata.documentType === "string" ? metadata.documentType : null,
    confidence: typeof classification?.confidence === "string" ? classification.confidence : null,
    summary: typeof classification?.summary === "string" ? classification.summary : null,
    model: typeof classification?.model === "string" ? classification.model : null,
    classifiedAt: typeof classification?.classifiedAt === "string" ? classification.classifiedAt : null
  };
}

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  toastEl.style.background = isError ? "#be123c" : "#0f172a";
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.add("hidden"), 3200);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }

  if (!response.ok) {
    throw new Error(data?.error || data?.raw || "request failed");
  }

  return data;
}

function getTheme() {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function updateThemeToggle() {
  themeToggleEl.textContent = getTheme() === "dark" ? "Lightmode" : "Darkmode";
}

function setTheme(theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem("rag-ui-theme", theme);
  updateThemeToggle();
}

function renderStats(status) {
  state.status = status;
  const cards = [
    { label: "Dokumente", value: status.counts.documents, hint: "Verwalteter Bestand" },
    { label: "Chunks", value: status.counts.chunks, hint: "Indexierte Einheiten" },
    { label: "Schedules", value: status.counts.schedules, hint: "Persistierte Cronjobs" },
    { label: "Embedding-Modell", value: status.config.embeddingModel, hint: status.ollamaReachable ? "Ollama erreichbar" : "Ollama Fehler" }
  ];

  statsEl.innerHTML = cards
    .map(
      (card) => `
        <article class="rounded-[1.5rem] border border-white/60 bg-white/75 p-5 shadow-panel backdrop-blur dark:border-white/10 dark:bg-white/5 dark:shadow-night">
          <div class="text-xs font-semibold uppercase tracking-[0.25em] text-ember dark:text-aurora">${escapeHtml(card.label)}</div>
          <div class="mt-3 font-display text-3xl font-bold">${escapeHtml(card.value)}</div>
          <div class="mt-2 text-sm text-slate-600 dark:text-slate-300">${escapeHtml(card.hint)}</div>
        </article>
      `
    )
    .join("");

  statusBadgeEl.textContent = status.ollamaReachable
    ? `Ollama erreichbar: ${status.config.embeddingModel}`
    : `Ollama Fehler: ${status.ollamaError}`;
  statusBadgeEl.className = `rounded-full px-4 py-2 text-sm font-semibold ${status.ollamaReachable ? "bg-mist text-spruce dark:bg-aurora/15 dark:text-aurora" : "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200"}`;

  renderElasticsearchAdminStatus(status.elasticsearch);
  renderClassificationAdminStatus(status.config);
}

function renderClassificationAdminStatus(config) {
  if (!classificationAdminStatusEl) {
    return;
  }

  const items = [
    {
      label: "KI-Server",
      value: config.ollamaBaseUrl || "-"
    },
    {
      label: "Modell",
      value: config.documentClassifierModel || "-"
    },
    {
      label: "Bestand",
      value: String(state.status?.counts?.documents ?? 0)
    },
    {
      label: "Aktive Typen",
      value: String(state.documentTypeSettings.filter((setting) => setting.enabled).length || config.documentTypeCount || 0)
    }
  ];

  classificationAdminStatusEl.innerHTML = items
    .map(
      (item) => `
        <article class="rounded-2xl border border-black/10 bg-cloud/55 px-4 py-3 dark:border-white/10 dark:bg-dusk/65">
          <div class="text-xs font-semibold uppercase tracking-[0.18em] text-black/45 dark:text-white/45">${escapeHtml(item.label)}</div>
          <div class="mt-2 break-words text-sm font-semibold text-black/80 dark:text-white/80">${escapeHtml(item.value)}</div>
        </article>
      `
    )
    .join("");
}

function renderEmbeddingProgress(progress) {
  if (!embeddingProgressPanelEl) {
    return;
  }

  if (!progress || progress.total === 0) {
    embeddingProgressPanelEl.classList.add("hidden");
    return;
  }

  const donePercent = Math.round(((progress.completed + progress.failed) / progress.total) * 100);

  if (progress.pending === 0 && progress.failed === 0) {
    embeddingProgressPanelEl.classList.add("hidden");
  } else {
    embeddingProgressPanelEl.classList.remove("hidden");
  }

  embeddingProgressSummaryEl.textContent = `${progress.completed} / ${progress.total} Chunks eingebettet (${progress.pending} ausstehend)`;
  embeddingProgressBarEl.style.width = `${donePercent}%`;

  if (progress.failed > 0) {
    embeddingProgressFailedEl.textContent = `${progress.failed} Chunk(s) konnten nicht eingebettet werden - siehe Logs.`;
    embeddingProgressFailedEl.classList.remove("hidden");
  } else {
    embeddingProgressFailedEl.classList.add("hidden");
  }
}

function renderGitImportAdminStatus(config, jobs = state.jobs) {
  if (!gitImportAdminStatusEl) {
    return;
  }

  const gitJobs = (jobs || []).filter((job) => job.queue === "git-sync" || job.name === "git-sync");
  const latestGitJob = gitJobs[0] || null;
  const items = [
    { label: "Cache-Verzeichnis", value: config.gitRepoCacheDir || "-" },
    { label: "Dateilimit", value: config.gitRepoMaxFileBytes ? `${config.gitRepoMaxFileBytes} Bytes` : "-" },
    { label: "Git-Jobs", value: String(gitJobs.length) },
    {
      label: "Letzter Stand",
      value: latestGitJob ? `${latestGitJob.state}${latestGitJob.data?.repositoryUrl ? ` · ${latestGitJob.data.repositoryUrl}` : ""}` : "kein Git-Job"
    }
  ];

  gitImportAdminStatusEl.innerHTML = items
    .map(
      (item) => `
        <article class="rounded-2xl border border-black/10 bg-cloud/55 px-4 py-3 dark:border-white/10 dark:bg-dusk/65">
          <div class="text-xs font-semibold uppercase tracking-[0.18em] text-black/45 dark:text-white/45">${escapeHtml(item.label)}</div>
          <div class="mt-2 break-words text-sm font-semibold text-black/80 dark:text-white/80">${escapeHtml(item.value)}</div>
        </article>
      `
    )
    .join("");
}

function splitCommaList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function renderDocumentTypeSettings(settings) {
  state.documentTypeSettings = settings;
  renderDocumentTypeFilterOptions();
  renderCategoryFilterOptions();

  if (!documentTypeSettingsEl || isBeingEdited(documentTypeSettingsEl)) {
    return;
  }

  if (!settings.length) {
    documentTypeSettingsEl.innerHTML = '<p class="text-sm text-slate-600 dark:text-slate-300">Keine Dokumenttypen geladen.</p>';
    return;
  }

  documentTypeSettingsEl.innerHTML = settings
    .map((setting) => {
      const searchSettings = setting.searchSettings || {};
      const chunkingSettings = setting.chunkingSettings || {};
      const globalChunkSize = state.status?.config?.chunkSize ?? "";
      const globalChunkOverlap = state.status?.config?.chunkOverlap ?? "";
      return `
        <form data-document-type-key="${escapeHtml(setting.key)}" class="rounded-3xl border border-black/10 bg-cloud/55 p-4 text-sm dark:border-white/10 dark:bg-dusk/65">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-semibold uppercase tracking-[0.18em] text-black/45 dark:text-white/45">${escapeHtml(setting.key)}</div>
              <div class="mt-1 font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(setting.label)}</div>
            </div>
            <label class="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
              <input name="enabled" type="checkbox" ${setting.enabled ? "checked" : ""} />
              aktiv
            </label>
          </div>
          <div class="mt-4 grid gap-3 md:grid-cols-2">
            <input name="label" value="${escapeHtml(setting.label)}" class="rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Label" />
            <input name="category" value="${escapeHtml(setting.category)}" class="rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Kategorie" />
            <input name="priority" type="number" min="1" max="9999" value="${escapeHtml(setting.priority)}" class="rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Prioritaet" />
            <input name="fileTypeHints" value="${escapeHtml((setting.fileTypeHints || []).join(", "))}" class="rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Dateitypen, z. B. md, pdf" />
          </div>
          <textarea name="description" rows="2" class="mt-3 w-full rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Beschreibung">${escapeHtml(setting.description)}</textarea>
          <textarea name="promptHint" rows="2" class="mt-3 w-full rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="LLM-Hinweis">${escapeHtml(setting.promptHint)}</textarea>
          <input name="keywords" value="${escapeHtml((setting.keywords || []).join(", "))}" class="mt-3 w-full rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Keywords, komma-separiert" />
          <input name="sourceTypeHints" value="${escapeHtml((setting.sourceTypeHints || []).join(", "))}" class="mt-3 w-full rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Source-Type-Hints, z. B. crawl, git" />
          <div class="mt-4 rounded-2xl border border-black/10 bg-white/70 p-4 dark:border-white/10 dark:bg-black/20">
            <div class="text-xs font-semibold uppercase tracking-[0.18em] text-black/45 dark:text-white/45">Suchprofil</div>
            <div class="mt-3 grid gap-3 md:grid-cols-2">
              <select name="searchProfile" class="rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25">
                <option value="generic" ${searchSettings.searchProfile === "generic" ? "selected" : ""}>Generisch</option>
                <option value="narrative" ${searchSettings.searchProfile === "narrative" ? "selected" : ""}>Narrativ / Kapitel</option>
                <option value="structured" ${searchSettings.searchProfile === "structured" ? "selected" : ""}>Strukturiert</option>
                <option value="reference" ${searchSettings.searchProfile === "reference" ? "selected" : ""}>Referenz / Nachschlagewerk</option>
                <option value="record" ${searchSettings.searchProfile === "record" ? "selected" : ""}>Vorgang / Record</option>
                <option value="code" ${searchSettings.searchProfile === "code" ? "selected" : ""}>Code / Schema</option>
              </select>
              <input name="adjacentSectionWindow" type="number" min="0" max="8" value="${escapeHtml(searchSettings.adjacentSectionWindow ?? 1)}" class="rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Nachbarschaftsfenster" />
              <input name="smallToBigWindow" type="number" min="0" max="8" value="${escapeHtml(searchSettings.smallToBigWindow ?? 1)}" class="rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Small-to-Big-Fenster" />
            </div>
            <div class="mt-3 grid gap-2 md:grid-cols-2">
              <label class="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                <input name="preferContentMatches" type="checkbox" ${searchSettings.preferContentMatches ? "checked" : ""} />
                Inhalts-Treffer bevorzugen
              </label>
              <label class="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                <input name="preferDocumentFocus" type="checkbox" ${searchSettings.preferDocumentFocus ? "checked" : ""} />
                Dokument-lokale Verfeinerung
              </label>
              <label class="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                <input name="requireFocusTerms" type="checkbox" ${searchSettings.requireFocusTerms ? "checked" : ""} />
                Fokus-Terme erzwingen
              </label>
              <label class="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                <input name="preferAdjacentSections" type="checkbox" ${searchSettings.preferAdjacentSections ? "checked" : ""} />
                Benachbarte Abschnitte bevorzugen
              </label>
            </div>
          </div>
          <div class="mt-4 rounded-2xl border border-black/10 bg-white/70 p-4 dark:border-white/10 dark:bg-black/20">
            <div class="text-xs font-semibold uppercase tracking-[0.18em] text-black/45 dark:text-white/45">Chunking</div>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Leer lassen, um den globalen Standard zu erben (aktuell ${escapeHtml(globalChunkSize)} / ${escapeHtml(globalChunkOverlap)} Tokens).</p>
            <div class="mt-3 grid gap-3 md:grid-cols-2">
              <input name="chunkSize" type="number" min="50" max="2000" value="${escapeHtml(chunkingSettings.chunkSize ?? "")}" class="rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Chunk-Groesse (Tokens), Standard: ${escapeHtml(globalChunkSize)}" />
              <input name="chunkOverlap" type="number" min="0" max="500" value="${escapeHtml(chunkingSettings.overlap ?? "")}" class="rounded-2xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-lagoon dark:border-white/10 dark:bg-black/25" placeholder="Chunk-Overlap (Tokens), Standard: ${escapeHtml(globalChunkOverlap)}" />
            </div>
          </div>
          <div class="mt-3 flex justify-end">
            <button class="rounded-full bg-graphite px-4 py-2 text-xs font-semibold text-white transition hover:bg-ember">Typ speichern</button>
          </div>
        </form>
      `;
    })
    .join("");

  documentTypeSettingsEl.querySelectorAll("[data-document-type-key]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const currentForm = event.currentTarget;
      const key = currentForm.dataset.documentTypeKey;
      const formData = new FormData(currentForm);

      try {
        await requestJson(`/api/admin/document-types/${encodeURIComponent(key)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: String(formData.get("label") || "").trim(),
            description: String(formData.get("description") || "").trim(),
            category: String(formData.get("category") || "").trim(),
            promptHint: String(formData.get("promptHint") || "").trim(),
            keywords: splitCommaList(formData.get("keywords")),
            sourceTypeHints: splitCommaList(formData.get("sourceTypeHints")),
            fileTypeHints: splitCommaList(formData.get("fileTypeHints")),
            priority: Number(formData.get("priority") || 100),
            enabled: formData.get("enabled") === "on",
            searchSettings: {
              searchProfile: String(formData.get("searchProfile") || "generic"),
              preferContentMatches: formData.get("preferContentMatches") === "on",
              preferDocumentFocus: formData.get("preferDocumentFocus") === "on",
              requireFocusTerms: formData.get("requireFocusTerms") === "on",
              preferAdjacentSections: formData.get("preferAdjacentSections") === "on",
              adjacentSectionWindow: Number(formData.get("adjacentSectionWindow") || 1),
              smallToBigWindow: Number(formData.get("smallToBigWindow") || 1)
            },
            chunkingSettings: {
              chunkSize: formData.get("chunkSize") ? Number(formData.get("chunkSize")) : null,
              overlap: formData.get("chunkOverlap") ? Number(formData.get("chunkOverlap")) : null
            }
          })
        });
        showToast(`Dokumenttyp ${key} aktualisiert`);
        releaseForm(documentTypeSettingsEl);
        await refreshDashboard();
      } catch (error) {
        showToast(error.message, true);
      }
    });
  });
}

function renderRagfindSettings(settings = state.ragfindSettings) {
  state.ragfindSettings = settings;

  if (!ragfindKnowledgeBaseOptionsEl || !ragfindSettingsSummaryEl) {
    return;
  }

  if (isBeingEdited(ragfindSettingsFormEl)) {
    ragfindSettingsSummaryEl.textContent = "Ungespeicherte Aenderungen - automatische Aktualisierung pausiert.";
    return;
  }

  if (!state.knowledgeBases.length) {
    ragfindKnowledgeBaseOptionsEl.innerHTML = '<p class="text-sm text-slate-600 dark:text-slate-300">Noch keine Wissensdatenbanken vorhanden.</p>';
    ragfindSettingsSummaryEl.textContent = "Keine Wissensdatenbanken vorhanden.";
    return;
  }

  const selectedIds = new Set((settings.knowledgeBaseIds || []).map((value) => Number(value)));
  ragfindKnowledgeBaseOptionsEl.innerHTML = state.knowledgeBases
    .map(
      (knowledgeBase) => `
        <label class="flex items-start gap-3 rounded-2xl border border-black/10 bg-cloud/55 px-4 py-3 dark:border-white/10 dark:bg-dusk/65 ${knowledgeBase.isEnabled === false ? "opacity-60" : ""}">
          <input type="checkbox" name="ragfindKnowledgeBaseIds" value="${escapeHtml(knowledgeBase.id)}" ${selectedIds.has(Number(knowledgeBase.id)) ? "checked" : ""} ${knowledgeBase.isEnabled === false ? "disabled" : ""} class="mt-1" />
          <span>
            <span class="block text-sm font-semibold text-black/80 dark:text-white/85">${escapeHtml(knowledgeBase.name)}</span>
            <span class="mt-1 block text-xs text-black/50 dark:text-white/45">${escapeHtml(knowledgeBase.slug)} · ${escapeHtml(knowledgeBase.documentCount)} Dokumente${knowledgeBase.isEnabled === false ? " · deaktiviert" : ""}</span>
          </span>
        </label>
      `
    )
    .join("");

  const selectedNames = (settings.knowledgeBases || []).map((knowledgeBase) => knowledgeBase.name);
  ragfindSettingsSummaryEl.textContent = selectedNames.length
    ? `Aktiv fuer RAGfind: ${selectedNames.join(", ")}`
    : "RAGfind hat aktuell keine Wissensdatenbanken konfiguriert.";
}

function fillModelSelect(selectEl, models, selectedValue) {
  if (!selectEl) {
    return;
  }

  const options = [...models];
  if (selectedValue && !options.includes(selectedValue)) {
    options.unshift(selectedValue);
  }

  selectEl.innerHTML = options.length
    ? options.map((model) => `<option value="${escapeHtml(model)}" ${model === selectedValue ? "selected" : ""}>${escapeHtml(model)}</option>`).join("")
    : '<option value="">Keine Modelle geladen</option>';

  if (selectedValue) {
    selectEl.value = selectedValue;
  }
}

// Das Dashboard aktualisiert sich alle 20 Sekunden selbst (siehe setInterval am
// Dateiende). Ohne diese Sperre ueberschreibt jede dieser Aktualisierungen die
// Felder eines Formulars, das gerade ausgefuellt wird - beim Einstellen einer
// neuen Provider-Verbindung sprangen dadurch alle Werte zurueck, bevor man auf
// Speichern klicken konnte.
const editedForms = new WeakSet();

function watchFormEdits(element) {
  if (!element) {
    return;
  }

  for (const type of ["input", "change"]) {
    element.addEventListener(type, () => editedForms.add(element));
  }
}

// Explizit als "in Bearbeitung" markieren, wenn die Absicht eindeutig ist, auch
// ohne dass ein input/change-Event geflogen ist - etwa nach dem Laden der
// Modell-Liste fuer eine neue Server-URL.
function markEdited(element) {
  if (element) {
    editedForms.add(element);
  }
}

function isBeingEdited(element) {
  return Boolean(element) && editedForms.has(element);
}

// Nach dem Speichern (oder bewusstem Verwerfen) darf wieder aktualisiert werden.
function releaseForm(element) {
  if (element) {
    editedForms.delete(element);
  }
}

function updateAiProviderApiKeyVisibility() {
  if (!aiProviderSelectEl || !aiProviderApiKeyFieldEl) {
    return;
  }

  const isOpenAi = aiProviderSelectEl.value === "openai";
  aiProviderApiKeyFieldEl.classList.toggle("hidden", !isOpenAi);
  aiProviderApiKeyHintEl.textContent = isOpenAi
    ? (state.aiProviderSettings.apiKeySet
        ? "Schluessel hinterlegt - leer lassen, um ihn beizubehalten."
        : "Optional. Lokale Server (vLLM, llama.cpp, LM Studio, TGI) brauchen in der Regel keinen.")
    : "";

  if (apiKeyClearRowEl) {
    // Only offer to remove a key when there is one to remove.
    const canClear = isOpenAi && Boolean(state.aiProviderSettings.apiKeySet);
    apiKeyClearRowEl.classList.toggle("hidden", !canClear);
    apiKeyClearRowEl.classList.toggle("flex", canClear);
    if (!canClear && apiKeyClearEl) {
      apiKeyClearEl.checked = false;
    }
  }
}

function renderAiProviderSettings(settings = state.aiProviderSettings) {
  state.aiProviderSettings = settings;

  if (!aiProviderSettingsFormEl) {
    return;
  }

  // Ungespeicherte Eingaben haben Vorrang vor dem gespeicherten Stand.
  if (isBeingEdited(aiProviderSettingsFormEl)) {
    if (aiProviderSettingsSummaryEl) {
      aiProviderSettingsSummaryEl.textContent = "Ungespeicherte Aenderungen - automatische Aktualisierung pausiert.";
    }
    return;
  }

  aiProviderSelectEl.value = settings.provider;
  aiProviderBaseUrlEl.value = settings.baseUrl || "";
  aiProviderApiKeyEl.value = "";
  aiProviderEmbeddingDimensionEl.textContent = settings.embeddingDimension != null ? String(settings.embeddingDimension) : "-";

  fillModelSelect(aiProviderEmbeddingModelEl, state.aiProviderModels, settings.embeddingModel);
  fillModelSelect(aiProviderSummaryModelEl, state.aiProviderModels, settings.summaryModel);
  fillModelSelect(aiProviderClassifierModelEl, state.aiProviderModels, settings.classifierModel);

  updateAiProviderApiKeyVisibility();

  aiProviderSettingsSummaryEl.textContent = settings.updatedAt
    ? `Provider: ${settings.provider === "openai" ? "OpenAI-kompatibel" : "Ollama"} - zuletzt aktualisiert ${formatDate(settings.updatedAt)}`
    : `Provider: ${settings.provider === "openai" ? "OpenAI-kompatibel" : "Ollama"}`;

  aiProviderReachabilityEl.textContent = "";

  if (rerankerEnabledEl) {
    rerankerEnabledEl.checked = Boolean(settings.rerankerEnabled);
    rerankerBaseUrlEl.value = settings.rerankerBaseUrl || "";
    rerankerModelEl.value = settings.rerankerModel || "";
    rerankerTopNEl.value = settings.rerankerTopN != null ? String(settings.rerankerTopN) : "12";

    if (!settings.rerankerEnabled) {
      rerankerStatusEl.textContent = "Reranker deaktiviert - es greift das heuristische Reranking.";
    } else if (!settings.rerankerHealth) {
      rerankerStatusEl.textContent = "Reranker aktiviert.";
    } else if (settings.rerankerHealth.reachable) {
      rerankerStatusEl.textContent = `Reranker erreichbar (${settings.rerankerModel}).`;
    } else {
      rerankerStatusEl.textContent = `Reranker NICHT erreichbar: ${settings.rerankerHealth.error || "unbekannter Fehler"} - Suchen laufen solange mit heuristischem Reranking.`;
    }
  }
}

async function loadAiProviderModelOptions() {
  if (!aiProviderBaseUrlEl || !aiProviderSelectEl) {
    return;
  }

  const provider = aiProviderSelectEl.value;
  const baseUrl = aiProviderBaseUrlEl.value.trim();
  const apiKey = aiProviderApiKeyEl.value.trim();

  if (!baseUrl) {
    showToast("Bitte zuerst eine Server-URL angeben", true);
    return;
  }

  aiProviderReachabilityEl.textContent = "Pruefe Erreichbarkeit und lade Modelle ...";

  try {
    const params = new URLSearchParams({ provider, baseUrl });
    if (apiKey) {
      params.set("apiKey", apiKey);
    }

    const result = await requestJson(`/api/admin/ai-provider/models?${params.toString()}`);
    const models = Array.isArray(result.models) ? result.models : [];
    state.aiProviderModels = models;

    fillModelSelect(aiProviderEmbeddingModelEl, models, aiProviderEmbeddingModelEl.value || state.aiProviderSettings.embeddingModel);
    fillModelSelect(aiProviderSummaryModelEl, models, aiProviderSummaryModelEl.value || state.aiProviderSettings.summaryModel);
    fillModelSelect(aiProviderClassifierModelEl, models, aiProviderClassifierModelEl.value || state.aiProviderSettings.classifierModel);

    // Wer Modelle fuer eine URL laedt, ist mitten in der Konfiguration: ab hier
    // darf die Hintergrund-Aktualisierung die Auswahl nicht zurueckstellen.
    markEdited(aiProviderSettingsFormEl);

    aiProviderReachabilityEl.textContent = models.length
      ? `Server erreichbar - ${models.length} Modell(e) gefunden.`
      : "Server erreichbar, aber keine Modelle gefunden.";
  } catch (error) {
    aiProviderReachabilityEl.textContent = `Server nicht erreichbar: ${error.message}`;
  }
}

function renderElasticsearchAdminStatus(elasticsearch) {
  if (!elasticsearchAdminStatusEl) {
    return;
  }

  if (!elasticsearch) {
    elasticsearchAdminStatusEl.innerHTML = '<p class="text-sm text-black/65 dark:text-white/60">Kein Elasticsearch-Status verfuegbar.</p>';
    return;
  }

  const items = [
    {
      label: "Aktiviert",
      value: elasticsearch.enabled ? "Ja" : "Nein",
      tone: elasticsearch.enabled ? "bg-lagoon/20 text-graphite dark:text-lagoon" : "bg-black/5 text-black/70 dark:bg-white/10 dark:text-white/70"
    },
    {
      label: "Erreichbar",
      value: elasticsearch.reachable ? "Ja" : "Nein",
      tone: elasticsearch.reachable ? "bg-lagoon/20 text-graphite dark:text-lagoon" : "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200"
    },
    {
      label: "Fehler",
      value: elasticsearch.error || "-",
      tone: elasticsearch.error ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200" : "bg-black/5 text-black/70 dark:bg-white/10 dark:text-white/70"
    },
    {
      label: "Dokumente",
      value: String(elasticsearch.indices?.documents ?? 0),
      tone: "bg-black/5 text-black/70 dark:bg-white/10 dark:text-white/70"
    },
    {
      label: "Chunks",
      value: String(elasticsearch.indices?.chunks ?? 0),
      tone: "bg-black/5 text-black/70 dark:bg-white/10 dark:text-white/70"
    }
  ];

  elasticsearchAdminStatusEl.innerHTML = items
    .map(
      (item) => `
        <article class="rounded-2xl border border-black/10 bg-cloud/55 px-4 py-3 dark:border-white/10 dark:bg-dusk/65">
          <div class="text-xs font-semibold uppercase tracking-[0.18em] text-black/45 dark:text-white/45">${escapeHtml(item.label)}</div>
          <div class="mt-2 inline-flex rounded-full px-3 py-1 text-sm font-semibold ${item.tone}">${escapeHtml(item.value)}</div>
        </article>
      `
    )
    .join("");
}

function renderConfig(config) {
  configEl.innerHTML = Object.entries(config)
    .map(
      ([key, value]) => `
        <div class="flex items-start justify-between gap-4 border-b border-slate-900/5 pb-2 text-sm dark:border-white/10">
          <dt class="font-semibold text-slate-700 dark:text-slate-100">${escapeHtml(key)}</dt>
          <dd class="max-w-[55%] break-words text-right text-slate-600 dark:text-slate-300">${escapeHtml(value)}</dd>
        </div>
      `
    )
    .join("");
}

function renderAdminUsers(users) {
  state.adminUsers = users;

  if (!adminUsersEl) {
    return;
  }

  if (!users.length) {
    adminUsersEl.innerHTML = '<p class="text-sm text-slate-600 dark:text-slate-300">Noch keine Admin-Benutzer vorhanden.</p>';
    return;
  }

  adminUsersEl.innerHTML = users
    .map(
      (user) => `
        <article class="rounded-2xl border border-black/10 bg-cloud/55 px-4 py-3 text-sm dark:border-white/10 dark:bg-dusk/65">
          <div class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(user.username)}</div>
          <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">Aktualisiert: ${escapeHtml(formatDate(user.updatedAt))}</div>
        </article>
      `
    )
    .join("");
}

const VIEW_KEYS = viewPanelEls.map((panel) => panel.dataset.viewPanel);
const DEFAULT_VIEW = "uebersicht";

function getViewFromHash() {
  const key = location.hash.replace(/^#\/?/, "");
  return VIEW_KEYS.includes(key) ? key : DEFAULT_VIEW;
}

function setActiveView(requestedView) {
  const view = VIEW_KEYS.includes(requestedView) ? requestedView : DEFAULT_VIEW;

  for (const panel of viewPanelEls) {
    panel.classList.toggle("hidden", panel.dataset.viewPanel !== view);
  }

  for (const button of viewNavButtons) {
    if (!button.dataset.view) {
      continue;
    }

    const isActive = button.dataset.view === view;
    button.classList.toggle("bg-graphite", isActive);
    button.classList.toggle("text-white", isActive);
    button.classList.toggle("dark:bg-aurora/20", isActive);
    button.classList.toggle("dark:text-aurora", isActive);
    button.classList.toggle("text-black/60", !isActive);
    button.classList.toggle("dark:text-white/60", !isActive);
  }

  const targetHash = `#/${view}`;
  if (location.hash !== targetHash) {
    history.replaceState(null, "", targetHash);
  }
}

function navigateToView(view) {
  const targetHash = `#/${view}`;
  if (location.hash === targetHash) {
    setActiveView(view);
  } else {
    location.hash = targetHash;
  }
}

function getSelectedKnowledgeBaseIdsFromForm() {
  return [...document.querySelectorAll("input[name='principalKnowledgeBaseIds']:checked")]
    .map((input) => Number(input.value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function getDefaultKnowledgeBaseId() {
  const enabledKnowledgeBases = state.knowledgeBases.filter((knowledgeBase) => knowledgeBase.isEnabled !== false);
  const defaultKnowledgeBase = enabledKnowledgeBases.find((knowledgeBase) => knowledgeBase.slug === "default");
  return Number(defaultKnowledgeBase?.id ?? enabledKnowledgeBases[0]?.id ?? state.knowledgeBases[0]?.id ?? 0) || null;
}

function renderImportKnowledgeBaseOptions() {
  if (!importKnowledgeBaseSelectEls.length) {
    return;
  }

  const enabledKnowledgeBases = state.knowledgeBases.filter((knowledgeBase) => knowledgeBase.isEnabled !== false);
  const options = enabledKnowledgeBases.length
    ? enabledKnowledgeBases
    : state.knowledgeBases;
  const defaultKnowledgeBaseId = getDefaultKnowledgeBaseId();

  importKnowledgeBaseSelectEls.forEach((select) => {
    // The directory sync accepts an empty value, which makes the worker map one
    // subdirectory per knowledge base instead of importing everything into one.
    const allowAuto = select.hasAttribute("data-allow-auto-knowledge-base");
    const previousRawValue = String(select.value || "");
    const previousValue = Number(previousRawValue);
    const keepAuto = allowAuto && select.dataset.knowledgeBaseInitialised === "true" && previousRawValue === "";
    const selectedKnowledgeBaseId = Number.isFinite(previousValue) && previousValue > 0
      ? previousValue
      : defaultKnowledgeBaseId;

    if (!options.length && !allowAuto) {
      select.innerHTML = '<option value="">Bitte zuerst eine Wissensdatenbank anlegen</option>';
      select.disabled = true;
      return;
    }

    select.disabled = false;
    select.innerHTML = [
      ...(allowAuto ? ['<option value="">Automatisch (Unterordner je Wissensdatenbank)</option>'] : []),
      ...options.map((knowledgeBase) => `<option value="${escapeHtml(knowledgeBase.id)}">${escapeHtml(knowledgeBase.name)}</option>`)
    ].join("");
    select.dataset.knowledgeBaseInitialised = "true";

    // "Automatisch" is the default for the sync form, and an explicit pick by
    // the user survives a re-render.
    if (allowAuto && (keepAuto || !select.dataset.knowledgeBaseTouched)) {
      select.value = "";
      return;
    }

    if (selectedKnowledgeBaseId && options.some((knowledgeBase) => Number(knowledgeBase.id) === Number(selectedKnowledgeBaseId))) {
      select.value = String(selectedKnowledgeBaseId);
    } else {
      select.value = String(defaultKnowledgeBaseId ?? options[0].id);
    }
  });
}

function renderDocumentTypeFilterOptions() {
  if (!documentTypeSelectEls.length) {
    return;
  }

  const options = state.documentTypeSettings.filter((setting) => setting.enabled !== false);

  documentTypeSelectEls.forEach((select) => {
    const previousValue = String(select.value || "");
    select.innerHTML = [
      '<option value="">Alle Typen</option>',
      ...options.map((setting) => `<option value="${escapeHtml(setting.key)}">${escapeHtml(setting.label)} (${escapeHtml(setting.key)})</option>`)
    ].join("");

    if (previousValue && options.some((setting) => setting.key === previousValue)) {
      select.value = previousValue;
    }
  });
}

function renderCategoryFilterOptions() {
  if (!categorySelectEls.length) {
    return;
  }

  const categories = [...new Set(
    state.documentTypeSettings
      .filter((setting) => setting.enabled !== false)
      .map((setting) => String(setting.category || "").trim().toLowerCase())
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));

  categorySelectEls.forEach((select) => {
    const previousValue = String(select.value || "");
    select.innerHTML = [
      '<option value="">Alle Kategorien</option>',
      '<option value="local">Local</option>',
      '<option value="web">Web</option>',
      ...categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
    ].join("");

    if (previousValue && [...categories, "local", "web"].includes(previousValue)) {
      select.value = previousValue;
    }
  });
}

function renderSourceTypeFilterOptions() {
  if (!sourceTypeSelectEls.length) {
    return;
  }

  const options = [...new Set([
    "upload",
    "directory",
    "crawl",
    "crawl-file",
    "git",
    ...state.documents.map((document) => String(document.source_type || "").trim().toLowerCase()).filter(Boolean)
  ])].sort((left, right) => left.localeCompare(right));

  sourceTypeSelectEls.forEach((select) => {
    const previousValue = String(select.value || "");
    select.innerHTML = [
      '<option value="">Alle Quellen</option>',
      ...options.map((sourceType) => `<option value="${escapeHtml(sourceType)}">${escapeHtml(sourceType)}</option>`)
    ].join("");

    if (previousValue && options.includes(previousValue)) {
      select.value = previousValue;
    }
  });
}

function renderPrincipalKnowledgeBaseOptions(selectedIds = []) {
  if (!principalKnowledgeBaseOptionsEl) {
    return;
  }

  if (!state.knowledgeBases.length) {
    principalKnowledgeBaseOptionsEl.innerHTML = '<p class="text-sm text-slate-600 dark:text-slate-300">Bitte zuerst mindestens eine Wissensdatenbank anlegen.</p>';
    return;
  }

  const selected = new Set(selectedIds.map((value) => Number(value)));
  principalKnowledgeBaseOptionsEl.innerHTML = state.knowledgeBases
    .map(
      (knowledgeBase) => `
        <label class="flex items-start gap-3 rounded-2xl border border-black/10 bg-cloud/55 px-4 py-3 text-sm transition hover:border-lagoon dark:border-white/10 dark:bg-dusk/65">
          <input name="principalKnowledgeBaseIds" type="checkbox" value="${escapeHtml(knowledgeBase.id)}" class="mt-1 h-4 w-4 rounded border-black/20 text-ember focus:ring-ember" ${selected.has(Number(knowledgeBase.id)) ? "checked" : ""} />
          <span>
            <span class="block font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(knowledgeBase.name)}</span>
            <span class="block text-xs text-slate-500 dark:text-slate-400">${escapeHtml(knowledgeBase.slug)}</span>
          </span>
        </label>
      `
    )
    .join("");
}

function resetKnowledgeBaseForm() {
  if (!knowledgeBaseFormEl) {
    return;
  }

  state.editingKnowledgeBaseId = null;
  knowledgeBaseFormEl.reset();
  knowledgeBaseFormEl.elements.isEnabled.checked = true;
}

function fillKnowledgeBaseForm(knowledgeBase) {
  state.editingKnowledgeBaseId = Number(knowledgeBase.id);
  knowledgeBaseFormEl.elements.name.value = knowledgeBase.name || "";
  knowledgeBaseFormEl.elements.slug.value = knowledgeBase.slug || "";
  knowledgeBaseFormEl.elements.description.value = knowledgeBase.description || "";
  knowledgeBaseFormEl.elements.isEnabled.checked = Boolean(knowledgeBase.isEnabled);
}

function renderKnowledgeBases(knowledgeBases) {
  state.knowledgeBases = knowledgeBases;
  renderImportKnowledgeBaseOptions();
  renderRagfindSettings();
  renderPrincipalKnowledgeBaseOptions(
    state.editingPrincipalId
      ? (state.mcpPrincipals.find((principal) => Number(principal.id) === Number(state.editingPrincipalId))?.knowledgeBases || []).map((kb) => kb.id)
      : []
  );

  if (!knowledgeBasesEl) {
    return;
  }

  if (!knowledgeBases.length) {
    knowledgeBasesEl.innerHTML = '<p class="text-sm text-slate-600 dark:text-slate-300">Noch keine Wissensdatenbanken vorhanden.</p>';
    return;
  }

  knowledgeBasesEl.innerHTML = knowledgeBases
    .map(
      (knowledgeBase) => `
        <article class="rounded-3xl border border-slate-900/5 bg-shell/55 p-4 dark:border-white/10 dark:bg-slate-950/45">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(knowledgeBase.name)}</h3>
                <span class="rounded-full px-2 py-1 text-[11px] font-semibold ${knowledgeBase.isEnabled ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/35 dark:text-emerald-200" : "bg-slate-200 text-slate-700 dark:bg-white/10 dark:text-slate-300"}">${knowledgeBase.isEnabled ? "aktiv" : "deaktiviert"}</span>
              </div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(knowledgeBase.slug)}</div>
              <p class="mt-3 text-sm text-slate-600 dark:text-slate-300">${escapeHtml(knowledgeBase.description || "Keine Beschreibung hinterlegt.")}</p>
              <div class="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span class="rounded-full bg-white/80 px-2 py-1 dark:bg-white/10">${escapeHtml(knowledgeBase.documentCount)} Dokumente</span>
                <span class="rounded-full bg-white/80 px-2 py-1 dark:bg-white/10">${escapeHtml(knowledgeBase.principalCount)} MCP-Zugaenge</span>
              </div>
            </div>
            <div class="flex shrink-0 flex-col gap-2">
              <button type="button" data-kb-action="edit" data-kb-id="${escapeHtml(knowledgeBase.id)}" class="rounded-full border border-black/10 px-3 py-2 text-xs font-semibold transition hover:border-lagoon dark:border-white/10">Bearbeiten</button>
              <button type="button" data-kb-action="delete" data-kb-id="${escapeHtml(knowledgeBase.id)}" data-kb-name="${escapeHtml(knowledgeBase.name)}" class="rounded-full border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-200 dark:hover:bg-rose-900/30">Loeschen</button>
            </div>
          </div>
        </article>
      `
    )
    .join("");

  knowledgeBasesEl.querySelectorAll("[data-kb-action='edit']").forEach((button) => {
    button.addEventListener("click", () => {
      const knowledgeBase = state.knowledgeBases.find((entry) => Number(entry.id) === Number(button.dataset.kbId));
      if (knowledgeBase) {
        fillKnowledgeBaseForm(knowledgeBase);
      }
    });
  });

  knowledgeBasesEl.querySelectorAll("[data-kb-action='delete']").forEach((button) => {
    button.addEventListener("click", () => deleteKnowledgeBaseEntry(button.dataset.kbId, button.dataset.kbName));
  });
}

function resetPrincipalForm() {
  if (!mcpPrincipalFormEl) {
    return;
  }

  state.editingPrincipalId = null;
  mcpPrincipalFormEl.reset();
  mcpPrincipalFormEl.elements.isEnabled.checked = true;
  renderPrincipalKnowledgeBaseOptions([]);
}

function fillPrincipalForm(principal) {
  state.editingPrincipalId = Number(principal.id);
  mcpPrincipalFormEl.elements.name.value = principal.name || "";
  mcpPrincipalFormEl.elements.description.value = principal.description || "";
  mcpPrincipalFormEl.elements.isEnabled.checked = Boolean(principal.isEnabled);
  renderPrincipalKnowledgeBaseOptions((principal.knowledgeBases || []).map((knowledgeBase) => knowledgeBase.id));
}

function renderMcpPrincipals(principals) {
  state.mcpPrincipals = principals;

  if (!mcpPrincipalsEl) {
    return;
  }

  if (!principals.length) {
    mcpPrincipalsEl.innerHTML = '<p class="text-sm text-slate-600 dark:text-slate-300">Noch keine MCP-Zugaenge vorhanden.</p>';
    return;
  }

  mcpPrincipalsEl.innerHTML = principals
    .map(
      (principal) => `
        <article class="rounded-3xl border border-slate-900/5 bg-shell/55 p-4 dark:border-white/10 dark:bg-slate-950/45">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(principal.name)}</h3>
                <span class="rounded-full px-2 py-1 text-[11px] font-semibold ${principal.isEnabled ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/35 dark:text-emerald-200" : "bg-slate-200 text-slate-700 dark:bg-white/10 dark:text-slate-300"}">${principal.isEnabled ? "aktiv" : "deaktiviert"}</span>
              </div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">Token: ${escapeHtml(principal.tokenPreview)}</div>
              <p class="mt-3 text-sm text-slate-600 dark:text-slate-300">${escapeHtml(principal.description || "Keine Beschreibung hinterlegt.")}</p>
              <div class="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                ${(principal.knowledgeBases || []).length
                  ? principal.knowledgeBases.map((knowledgeBase) => `<span class="rounded-full bg-white/80 px-2 py-1 dark:bg-white/10">${escapeHtml(knowledgeBase.name)}</span>`).join("")
                  : '<span class="rounded-full bg-white/80 px-2 py-1 dark:bg-white/10">Keine KB-Berechtigung</span>'}
              </div>
            </div>
            <div class="flex shrink-0 flex-col gap-2">
              <button type="button" data-principal-action="edit" data-principal-id="${escapeHtml(principal.id)}" class="rounded-full border border-black/10 px-3 py-2 text-xs font-semibold transition hover:border-lagoon dark:border-white/10">Bearbeiten</button>
              <button type="button" data-principal-action="rotate" data-principal-id="${escapeHtml(principal.id)}" class="rounded-full border border-lagoon/40 bg-lagoon/15 px-3 py-2 text-xs font-semibold text-graphite transition hover:border-lagoon hover:bg-lagoon/25 dark:border-aurora/35 dark:bg-aurora/15 dark:text-white dark:hover:bg-aurora/25">Token drehen</button>
              <button type="button" data-principal-action="delete" data-principal-id="${escapeHtml(principal.id)}" data-principal-name="${escapeHtml(principal.name)}" class="rounded-full border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-200 dark:hover:bg-rose-900/30">Loeschen</button>
            </div>
          </div>
        </article>
      `
    )
    .join("");

  mcpPrincipalsEl.querySelectorAll("[data-principal-action='edit']").forEach((button) => {
    button.addEventListener("click", () => {
      const principal = state.mcpPrincipals.find((entry) => Number(entry.id) === Number(button.dataset.principalId));
      if (principal) {
        fillPrincipalForm(principal);
      }
    });
  });

  mcpPrincipalsEl.querySelectorAll("[data-principal-action='rotate']").forEach((button) => {
    button.addEventListener("click", () => rotatePrincipalToken(button.dataset.principalId));
  });

  mcpPrincipalsEl.querySelectorAll("[data-principal-action='delete']").forEach((button) => {
    button.addEventListener("click", () => deletePrincipal(button.dataset.principalId, button.dataset.principalName));
  });
}

async function loadKnowledgeBases() {
  renderKnowledgeBases(await requestJson("/api/admin/knowledge-bases"));
}

async function loadMcpPrincipals() {
  renderMcpPrincipals(await requestJson("/api/admin/mcp-principals"));
}

async function loadAdminUsers() {
  renderAdminUsers(await requestJson("/api/admin/users"));
}

async function deleteKnowledgeBaseEntry(knowledgeBaseId, name) {
  const normalizedId = Number(knowledgeBaseId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
    showToast("ungueltige Wissensdatenbank-ID", true);
    return;
  }

  if (!window.confirm(`Wissensdatenbank wirklich loeschen?\n\n${name || `ID ${normalizedId}`}`)) {
    return;
  }

  try {
    await requestJson(`/api/admin/knowledge-bases/${normalizedId}`, { method: "DELETE" });
    showToast("Wissensdatenbank geloescht");
    if (state.editingKnowledgeBaseId === normalizedId) {
      resetKnowledgeBaseForm();
    }
    await loadKnowledgeBases();
    await loadMcpPrincipals();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deletePrincipal(principalId, name) {
  const normalizedId = Number(principalId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
    showToast("ungueltige Principal-ID", true);
    return;
  }

  if (!window.confirm(`MCP-Zugang wirklich loeschen?\n\n${name || `ID ${normalizedId}`}`)) {
    return;
  }

  try {
    await requestJson(`/api/admin/mcp-principals/${normalizedId}`, { method: "DELETE" });
    showToast("MCP-Zugang geloescht");
    if (state.editingPrincipalId === normalizedId) {
      resetPrincipalForm();
    }
    await loadMcpPrincipals();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function rotatePrincipalToken(principalId) {
  const normalizedId = Number(principalId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
    showToast("ungueltige Principal-ID", true);
    return;
  }

  try {
    const payload = await requestJson(`/api/admin/mcp-principals/${normalizedId}/rotate-token`, { method: "POST" });
    if (mcpTokenOutputEl) {
      mcpTokenOutputEl.classList.remove("hidden");
      mcpTokenOutputEl.textContent = `Neues Token fuer ${payload.principal.name}:\n\n${payload.token}`;
    }
    showToast("Token rotiert");
    await loadMcpPrincipals();
  } catch (error) {
    showToast(error.message, true);
  }
}

function paginateItems(items, currentPage) {
  const totalPages = Math.max(1, Math.ceil(items.length / state.pageSize));
  const page = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (page - 1) * state.pageSize;
  return {
    page,
    totalPages,
    items: items.slice(startIndex, startIndex + state.pageSize),
    totalItems: items.length,
    startIndex
  };
}

function renderPagination(targetEl, page, totalPages, totalItems, kind) {
  if (!targetEl) {
    return;
  }

  if (totalItems <= state.pageSize) {
    targetEl.innerHTML = "";
    return;
  }

  targetEl.innerHTML = `
    <div class="flex flex-col gap-3 rounded-2xl border border-black/5 bg-white/55 px-4 py-3 text-sm dark:border-white/10 dark:bg-black/15 sm:flex-row sm:items-center sm:justify-between">
      <div class="text-black/65 dark:text-white/60">Seite ${page} von ${totalPages} · ${totalItems} Eintraege</div>
      <div class="flex gap-2">
        <button type="button" data-page-kind="${escapeHtml(kind)}" data-page-action="prev" class="rounded-full border border-black/10 px-4 py-2 text-sm font-semibold transition hover:border-lagoon disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10" ${page <= 1 ? "disabled" : ""}>Zurueck</button>
        <button type="button" data-page-kind="${escapeHtml(kind)}" data-page-action="next" class="rounded-full border border-black/10 px-4 py-2 text-sm font-semibold transition hover:border-lagoon disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10" ${page >= totalPages ? "disabled" : ""}>Weiter</button>
      </div>
    </div>
  `;

  targetEl.querySelectorAll("[data-page-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.dataset.pageKind === "jobs") {
        state.jobsPage += button.dataset.pageAction === "next" ? 1 : -1;
        renderJobs(state.jobs);
        return;
      }

      state.documentsPage += button.dataset.pageAction === "next" ? 1 : -1;
      renderDocuments(state.documents);
    });
  });
}

function renderJobs(jobs) {
  state.jobs = jobs;
  renderGitImportAdminStatus(state.status?.config || {}, jobs);

  if (!jobs.length) {
    jobsEl.innerHTML = '<p class="text-slate-600 dark:text-slate-300">Keine Jobs vorhanden.</p>';
    jobsPaginationEl.innerHTML = "";
    return;
  }

  const pagination = paginateItems(jobs, state.jobsPage);
  state.jobsPage = pagination.page;

  jobsEl.innerHTML = pagination.items
    .map(
      (job) => `
        <article class="rounded-3xl border border-slate-900/5 bg-shell/55 p-4 dark:border-white/10 dark:bg-slate-950/45">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="font-semibold">${escapeHtml(job.queue)} / ${escapeHtml(job.name)}</div>
              <div class="text-xs text-slate-500 dark:text-slate-400">Job ${escapeHtml(job.id)} · ${escapeHtml(formatDate(job.timestamp))}</div>
            </div>
            <span class="rounded-full px-3 py-1 text-xs font-semibold ${job.state === "failed" ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200" : job.state === "completed" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/35 dark:text-emerald-200" : "bg-mist text-spruce dark:bg-aurora/15 dark:text-aurora"}">${escapeHtml(job.state)}</span>
          </div>
          <pre class="mt-3 overflow-auto rounded-2xl bg-white/80 p-3 text-xs text-slate-700 dark:bg-black/30 dark:text-slate-200">${formatJson(job.data)}</pre>
          ${job.result ? `<details class="mt-2 rounded-2xl bg-white/80 p-3 text-xs text-slate-700 dark:bg-black/30 dark:text-slate-200"><summary class="cursor-pointer font-semibold">Ergebnis</summary><pre class="mt-2 overflow-auto">${formatJson(job.result)}</pre></details>` : ""}
          ${job.failedReason ? `<p class="mt-2 text-xs text-rose-700 dark:text-rose-300">${escapeHtml(job.failedReason)}</p>` : ""}
          ${Array.isArray(job.stacktrace) && job.stacktrace.length ? `<details class="mt-2 rounded-2xl bg-rose-50/80 p-3 text-xs text-rose-900 dark:bg-rose-950/30 dark:text-rose-100"><summary class="cursor-pointer font-semibold">Stacktrace</summary><pre class="mt-2 overflow-auto whitespace-pre-wrap">${escapeHtml(job.stacktrace.join("\n\n"))}</pre></details>` : ""}
        </article>
      `
    )
    .join("");

  renderPagination(jobsPaginationEl, pagination.page, pagination.totalPages, pagination.totalItems, "jobs");
}

function renderSchedules(schedules) {
  if (!schedules.length) {
    schedulesEl.innerHTML = '<p class="text-slate-600 dark:text-slate-300">Keine Schedules vorhanden.</p>';
    return;
  }

  schedulesEl.innerHTML = schedules
    .map(
      (schedule) => `
        <article class="rounded-3xl border border-slate-900/5 bg-shell/55 p-4 dark:border-white/10 dark:bg-slate-950/45">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="font-semibold">${escapeHtml(schedule.job_type)}</div>
              <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(formatDate(schedule.created_at))}</div>
            </div>
            <span class="rounded-full bg-mist px-3 py-1 text-xs font-semibold text-spruce dark:bg-aurora/15 dark:text-aurora">${escapeHtml(schedule.cron_expression)}</span>
          </div>
          <pre class="mt-3 overflow-auto rounded-2xl bg-white/80 p-3 text-xs text-slate-700 dark:bg-black/30 dark:text-slate-200">${formatJson(schedule.payload)}</pre>
        </article>
      `
    )
    .join("");
}

function updateAnalysisButtons() {
  const disabled = !state.selectedDocumentId;
  for (const button of analysisButtons) {
    button.disabled = disabled;
    button.className = `analysis-button rounded-full border px-4 py-2 text-xs font-semibold transition ${disabled ? "cursor-not-allowed border-slate-900/10 text-slate-400 dark:border-white/10 dark:text-slate-500" : "border-slate-900/10 text-slate-700 hover:border-spruce hover:text-spruce dark:border-white/10 dark:text-slate-200 dark:hover:border-aurora dark:hover:text-aurora"}`;
  }
}

function renderDocuments(documents) {
  state.documents = documents;
  renderSourceTypeFilterOptions();
  const pagination = paginateItems(documents, state.documentsPage);
  state.documentsPage = pagination.page;
  documentsSummaryEl.textContent = `${documents.length} Dokumente im aktuellen Filter.`;

  if (!documents.length) {
    documentsEl.innerHTML = '<div class="px-4 py-5 text-sm text-slate-600 dark:text-slate-300">Keine Dokumente im aktuellen Filter gefunden.</div>';
    documentsPaginationEl.innerHTML = "";
    return;
  }

  documentsEl.innerHTML = pagination.items
    .map((document) => {
      const classification = getClassificationInfo(document);
      return `
        <article class="grid grid-cols-[88px_minmax(0,1.6fr)_minmax(0,0.8fr)_120px] gap-3 px-4 py-3 transition hover:bg-black/5 dark:hover:bg-white/5 ${Number(document.id) === Number(state.selectedDocumentId) ? "bg-black/5 dark:bg-white/5" : ""}">
          <div class="text-sm font-semibold text-slate-700 dark:text-slate-100">${escapeHtml(document.id)}</div>
          <div class="min-w-0">
            <div class="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(document.title || document.source_ref)}</div>
            <div class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">${escapeHtml(document.source_ref)}</div>
            <div class="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span>${escapeHtml(document.source_type)}</span>
              <span>${escapeHtml(document.file_type || "unknown")}</span>
              <span>${escapeHtml(document.text_length || 0)} Zeichen</span>
            </div>
          </div>
          <div class="min-w-0 pt-0.5 text-xs text-slate-600 dark:text-slate-300">
            <div class="font-semibold">${escapeHtml(document.document_type || "generic")}</div>
            <div class="mt-1 truncate">${escapeHtml(classification.confidence ? `LLM ${classification.confidence}` : "heuristisch")}</div>
            <div class="mt-1 truncate">${document.original_file?.localAvailable ? "lokal verfuegbar" : "ohne lokale Kopie"}</div>
            <div class="mt-1 truncate">${escapeHtml(formatDate(document.created_at))}</div>
          </div>
          <div class="flex flex-col gap-2">
            <button type="button" data-document-id="${escapeHtml(document.id)}" data-action="select" class="rounded-full border border-lagoon/40 bg-lagoon/15 px-3 py-2 text-xs font-semibold text-graphite transition hover:border-lagoon hover:bg-lagoon/25 dark:border-aurora/35 dark:bg-aurora/15 dark:text-white dark:hover:bg-aurora/25">Details</button>
            <button type="button" data-document-id="${escapeHtml(document.id)}" data-action="reclassify" class="rounded-full border border-black/10 px-3 py-2 text-xs font-semibold transition hover:border-lagoon dark:border-white/10">Reclassify</button>
            <button type="button" data-document-id="${escapeHtml(document.id)}" data-document-title="${escapeHtml(document.title || document.source_ref)}" data-action="delete" class="rounded-full border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-200 dark:hover:bg-rose-900/30">Loeschen</button>
          </div>
        </article>
      `;
    })
    .join("");

  renderPagination(documentsPaginationEl, pagination.page, pagination.totalPages, pagination.totalItems, "documents");

  documentsEl.querySelectorAll("[data-action='select']").forEach((button) => {
    button.addEventListener("click", () => loadDocumentPreview(button.dataset.documentId));
  });
  documentsEl.querySelectorAll("[data-action='reclassify']").forEach((button) => {
    button.addEventListener("click", () => reclassifyDocument(button.dataset.documentId));
  });
  documentsEl.querySelectorAll("[data-action='delete']").forEach((button) => {
    button.addEventListener("click", () => deleteDocument(button.dataset.documentId, button.dataset.documentTitle));
  });
}

function renderDocumentPreview(payload) {
  const classification = getClassificationInfo(payload.document);
  const structure = (payload.structure || [])
    .map(
      (node) => `
        <article class="rounded-2xl border border-slate-900/5 bg-white/75 p-4 dark:border-white/10 dark:bg-black/25">
          <div class="text-xs font-semibold uppercase tracking-[0.18em] text-ember dark:text-aurora">Ebene ${escapeHtml(node.level)}</div>
          <h3 class="mt-1 font-semibold">${escapeHtml(node.title)}</h3>
          <div class="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            <span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">${escapeHtml(node.sectionType || "generic")}</span>
            <span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">Seiten ${escapeHtml(node.pageStart ?? "-")}-${escapeHtml(node.pageEnd ?? "-")}</span>
          </div>
          <p class="mt-3 text-xs text-slate-600 dark:text-slate-300">${escapeHtml(node.preview || "")}</p>
        </article>
      `
    )
    .join("");

  const sections = (payload.sections || [])
    .map(
      (section) => `
        <article class="rounded-2xl border border-slate-900/5 bg-white/75 p-4 dark:border-white/10 dark:bg-black/25">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-semibold uppercase tracking-[0.18em] text-ember dark:text-aurora">Abschnitt ${escapeHtml(section.index)}</div>
              <h3 class="mt-1 font-semibold">${escapeHtml(section.title)}</h3>
              <div class="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">${escapeHtml(section.sectionType || "generic")}</span>
                <span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">Seiten ${escapeHtml(section.pageStart ?? "-")}-${escapeHtml(section.pageEnd ?? "-")}</span>
              </div>
            </div>
            <span class="rounded-full bg-mist px-3 py-1 text-xs font-semibold text-spruce dark:bg-aurora/15 dark:text-aurora">Score ${escapeHtml(Number(section.matchScore || 0).toFixed(1))}</span>
          </div>
          <p class="mt-3 text-xs text-slate-600 dark:text-slate-300">${escapeHtml(section.preview || "")}</p>
        </article>
      `
    )
    .join("");

  documentPreviewEl.innerHTML = `
    <section class="rounded-3xl border border-slate-900/5 bg-shell/35 p-5 dark:border-white/10 dark:bg-slate-950/45">
      <div class="text-xs font-semibold uppercase tracking-[0.18em] text-ember dark:text-aurora">Dokument</div>
      <h3 class="mt-2 font-display text-2xl font-semibold">${escapeHtml(payload.document.title || payload.document.sourceRef)}</h3>
      <div class="mt-3 flex flex-wrap gap-2 text-xs text-slate-600 dark:text-slate-300">
        <span class="rounded-full bg-white/80 px-3 py-1 dark:bg-white/10">ID ${escapeHtml(payload.document.id)}</span>
        <span class="rounded-full bg-white/80 px-3 py-1 dark:bg-white/10">${escapeHtml(payload.document.sourceType)}</span>
        <span class="rounded-full bg-white/80 px-3 py-1 dark:bg-white/10">${escapeHtml(payload.document.fileType || "unknown")}</span>
        <span class="rounded-full bg-white/80 px-3 py-1 dark:bg-white/10">${escapeHtml(payload.documentType || "generic")}</span>
        <span class="rounded-full bg-white/80 px-3 py-1 dark:bg-white/10">${escapeHtml(classification.confidence ? `LLM ${classification.confidence}` : "heuristisch")}</span>
        <span class="rounded-full bg-white/80 px-3 py-1 dark:bg-white/10">${escapeHtml(payload.totalLength)} Zeichen</span>
      </div>
      <div class="mt-4 rounded-2xl border border-slate-900/5 bg-white/75 p-4 text-xs text-slate-600 dark:border-white/10 dark:bg-black/25 dark:text-slate-300">
        <div class="font-semibold text-slate-800 dark:text-slate-100">Klassifizierung</div>
        <div class="mt-2 flex flex-wrap gap-2">
          <span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">Typ ${escapeHtml(payload.documentType || "generic")}</span>
          <span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">Confidence ${escapeHtml(classification.confidence || "-")}</span>
          <span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">Modell ${escapeHtml(classification.model || "-")}</span>
        </div>
        <p class="mt-3 leading-5">${escapeHtml(classification.summary || "Keine LLM-Zusammenfassung vorhanden.")}</p>
        <div class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">Zuletzt klassifiziert: ${escapeHtml(formatDate(classification.classifiedAt))}</div>
      </div>
      <p class="mt-4 break-all text-xs text-slate-500 dark:text-slate-400">${escapeHtml(payload.document.sourceRef)}</p>
      <div class="mt-4 flex flex-wrap gap-3">
        ${payload.originalFile?.downloadUrl ? `<a class="inline-flex rounded-full border border-slate-900/10 px-4 py-2 text-xs font-semibold text-spruce transition hover:border-spruce dark:border-white/10 dark:text-aurora dark:hover:border-aurora" href="${escapeHtml(payload.originalFile.downloadUrl)}">Originaldokument herunterladen</a>` : ""}
        <button type="button" id="reclassify-selected-document" class="rounded-full border border-black/10 px-4 py-2 text-xs font-semibold transition hover:border-lagoon dark:border-white/10">Dokument reclassify</button>
        <button type="button" id="delete-selected-document" class="rounded-full border border-rose-200 px-4 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-200 dark:hover:bg-rose-900/30">Dokument loeschen</button>
      </div>
      <pre class="mt-4 max-h-[30rem] overflow-auto rounded-3xl bg-slate-950 p-4 text-xs text-shell dark:bg-black">${escapeHtml(payload.fulltext || "")}</pre>
    </section>
    <section>
      <div class="mb-3">
        <div class="text-xs font-semibold uppercase tracking-[0.18em] text-ember dark:text-aurora">Abschnitte</div>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">Persistierte Struktur fuer Preview, Small-to-Big und dokumentzentrierte Navigation.</p>
      </div>
      <div class="space-y-3">${sections || '<p class="text-sm text-slate-600 dark:text-slate-300">Keine Abschnitte erkannt.</p>'}</div>
      <div class="mt-5">
        <div class="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ember dark:text-aurora">Strukturbaum</div>
        <div class="space-y-3">${structure || '<p class="text-sm text-slate-600 dark:text-slate-300">Keine Struktur verfuegbar.</p>'}</div>
      </div>
    </section>
  `;

  const reclassifyButton = document.getElementById("reclassify-selected-document");
  if (reclassifyButton) {
    reclassifyButton.addEventListener("click", () => reclassifyDocument(payload.document.id));
  }

  const deleteButton = document.getElementById("delete-selected-document");
  if (deleteButton) {
    deleteButton.addEventListener("click", () => deleteDocument(payload.document.id, payload.document.title || payload.document.sourceRef));
  }
}

async function reclassifyDocument(documentId) {
  const normalizedId = Number(documentId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
    showToast("ungueltige Dokument-ID", true);
    return;
  }

  try {
    const result = await requestJson(`/api/documents/${normalizedId}/reclassify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    showToast(`Dokument neu klassifiziert (${result.documentType || "generic"})`);
    await refreshDashboard();
    if (state.selectedDocumentId === normalizedId) {
      await loadDocumentPreview(normalizedId);
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderAnalysis(kind, payload) {
  const titles = {
    summary: "Dokumentzusammenfassung",
    actions: "Meeting Actions",
    decisions: "Decisions",
    deadlines: "Deadlines",
    requirements: "Requirements",
    "config-keys": "Config Keys",
    "setup-steps": "Setup Steps",
    "api-surface": "API Surface",
    "operational-notes": "Operational Notes",
    risks: "Risks",
    entities: "Entities"
  };

  if (kind === "summary") {
    documentAnalysisEl.innerHTML = `
      <div class="text-xs font-semibold uppercase tracking-[0.18em] text-ember dark:text-aurora">${escapeHtml(titles[kind])}</div>
      <p class="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-slate-200">${escapeHtml(payload.summary || "Keine Summary verfuegbar.")}</p>
      <div class="mt-3 text-xs text-slate-500 dark:text-slate-400">Methode: ${escapeHtml(payload.method)} · Excerpts: ${escapeHtml(payload.excerptCount)}</div>
    `;
    return;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  documentAnalysisEl.innerHTML = `
    <div class="flex items-center justify-between gap-3">
      <div class="text-xs font-semibold uppercase tracking-[0.18em] text-ember dark:text-aurora">${escapeHtml(titles[kind] || kind)}</div>
      <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(items.length)} Treffer</div>
    </div>
    <div class="mt-4 space-y-3">
      ${items.length
        ? items
            .map(
              (item, index) => `
                <article class="rounded-2xl border border-slate-900/5 bg-white/75 p-4 dark:border-white/10 dark:bg-black/25">
                  <div class="flex items-start justify-between gap-4">
                    <div class="min-w-0">
                      <div class="text-xs font-semibold uppercase tracking-[0.18em] text-ember dark:text-aurora">Eintrag ${index + 1}</div>
                      <h3 class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(item.text)}</h3>
                    </div>
                    <span class="rounded-full bg-mist px-3 py-1 text-xs font-semibold text-spruce dark:bg-aurora/15 dark:text-aurora">${escapeHtml(item.confidence)}</span>
                  </div>
                  <div class="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                    <span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">Abschnitt ${escapeHtml(item.sectionIndex ?? "-")}</span>
                    ${item.sectionTitle ? `<span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">${escapeHtml(item.sectionTitle)}</span>` : ""}
                    ${item.entityType ? `<span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">${escapeHtml(item.entityType)}</span>` : ""}
                    ${item.dueDate ? `<span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">Due ${escapeHtml(item.dueDate)}</span>` : ""}
                    ${item.assignee ? `<span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">Owner ${escapeHtml(item.assignee)}</span>` : ""}
                    ${item.status ? `<span class="rounded-full bg-shell px-2 py-1 dark:bg-white/10">${escapeHtml(item.status)}</span>` : ""}
                  </div>
                  ${item.evidence ? `<p class="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300">${escapeHtml(item.evidence)}</p>` : ""}
                </article>
              `
            )
            .join("")
        : '<p class="text-sm text-slate-600 dark:text-slate-300">Keine Treffer fuer diese Analyse.</p>'}
    </div>
  `;
}

async function loadDocuments() {
  const params = new URLSearchParams();
  const filters = state.filters;
  if (filters.query) params.set("query", filters.query);
  if (filters.category) params.set("category", filters.category);
  if (filters.sourceType) params.set("sourceType", filters.sourceType);
  if (filters.documentType) params.set("documentType", filters.documentType);
  if (filters.limit) params.set("limit", String(filters.limit));
  const documents = await requestJson(`/api/documents?${params.toString()}`);
  renderDocuments(documents);
}

async function loadDocumentPreview(documentId) {
  const normalizedId = Number(documentId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
    showToast("ungueltige Dokument-ID", true);
    return;
  }

  state.selectedDocumentId = normalizedId;
  documentPreviewFormEl.elements.documentId.value = String(normalizedId);
  updateAnalysisButtons();
  documentAnalysisEl.innerHTML = '<div class="text-sm text-slate-600 dark:text-slate-300">Dokument geladen. Waehle jetzt eine Analyse aus.</div>';
  documentPreviewEl.innerHTML = '<div class="rounded-3xl border border-dashed border-slate-900/10 bg-shell/40 p-4 text-sm text-slate-600 dark:border-white/10 dark:bg-slate-950/40 dark:text-slate-300">Lade Dokument...</div>';

  try {
    const payload = await requestJson(`/api/documents/${normalizedId}?maxChars=14000`);
    renderDocumentPreview(payload);
  } catch (error) {
    documentPreviewEl.innerHTML = '<div class="rounded-3xl border border-dashed border-slate-900/10 bg-shell/40 p-4 text-sm text-rose-700 dark:border-white/10 dark:bg-slate-950/40 dark:text-rose-300">Dokument konnte nicht geladen werden.</div>';
    showToast(error.message, true);
  }
}

async function runAnalysis(kind) {
  if (!state.selectedDocumentId) {
    showToast("zuerst ein Dokument auswaehlen", true);
    return;
  }

  const endpoint = kind === "summary"
    ? `/api/documents/${state.selectedDocumentId}/summary`
    : `/api/documents/${state.selectedDocumentId}/analysis/${kind}`;

  documentAnalysisEl.innerHTML = '<div class="text-sm text-slate-600 dark:text-slate-300">Analyse laeuft...</div>';
  try {
    const payload = await requestJson(endpoint);
    renderAnalysis(kind, payload);
  } catch (error) {
    documentAnalysisEl.innerHTML = '<div class="text-sm text-rose-700 dark:text-rose-300">Analyse konnte nicht geladen werden.</div>';
    showToast(error.message, true);
  }
}

async function deleteDocument(documentId, title) {
  const normalizedId = Number(documentId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
    showToast("ungueltige Dokument-ID", true);
    return;
  }

  const confirmed = window.confirm(`Dokument wirklich loeschen?\n\n${title || `ID ${normalizedId}`}`);
  if (!confirmed) {
    return;
  }

  try {
    await requestJson(`/api/documents/${normalizedId}`, { method: "DELETE" });
    showToast("Dokument geloescht");
    if (state.selectedDocumentId === normalizedId) {
      state.selectedDocumentId = null;
      updateAnalysisButtons();
      documentPreviewFormEl.reset();
      documentAnalysisEl.innerHTML = '<div class="text-sm text-slate-600 dark:text-slate-300">Noch keine Analyse gestartet.</div>';
      documentPreviewEl.innerHTML = '<div class="rounded-3xl border border-dashed border-slate-900/10 bg-shell/40 p-4 text-sm text-slate-600 dark:border-white/10 dark:bg-slate-950/40 dark:text-slate-300">Noch kein Dokument ausgewaehlt.</div>';
    }
    await refreshDashboard();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function refreshDashboard() {
  const [status, config, jobs, schedules, knowledgeBases, principals, adminUsers, documentTypeSettings, ragfindSettings, aiProviderSettings, embeddingProgress] = await Promise.all([
    requestJson("/api/status"),
    requestJson("/api/config"),
    requestJson("/api/jobs"),
    requestJson("/api/schedules"),
    requestJson("/api/admin/knowledge-bases"),
    requestJson("/api/admin/mcp-principals"),
    requestJson("/api/admin/users"),
    requestJson("/api/admin/document-types"),
    requestJson("/api/admin/ragfind/settings"),
    requestJson("/api/admin/ai-provider/settings"),
    requestJson("/api/admin/embeddings/pending-status")
  ]);

  renderStats(status);
  renderConfig(config);
  renderJobs(jobs);
  renderSchedules(schedules);
  renderKnowledgeBases(knowledgeBases);
  renderMcpPrincipals(principals);
  renderAdminUsers(adminUsers);
  renderDocumentTypeSettings(documentTypeSettings);
  renderRagfindSettings(ragfindSettings);
  renderAiProviderSettings(aiProviderSettings);
  renderEmbeddingProgress(embeddingProgress);
  await loadDocuments();

  schedulePendingEmbeddingPoll(embeddingProgress);
}

let embeddingProgressPollTimer = null;

function schedulePendingEmbeddingPoll(progress) {
  if (embeddingProgressPollTimer) {
    clearTimeout(embeddingProgressPollTimer);
    embeddingProgressPollTimer = null;
  }

  if (!progress || (progress.pending === 0 && progress.failed === 0)) {
    return;
  }

  embeddingProgressPollTimer = setTimeout(async () => {
    try {
      const next = await requestJson("/api/admin/embeddings/pending-status");
      renderEmbeddingProgress(next);
      schedulePendingEmbeddingPoll(next);
    } catch {
      // dashboard's own 20s refresh will pick this back up
    }
  }, 5000);
}

function onSubmitJson(form, url, buildPayload) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = buildPayload(new FormData(form));
      await requestJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      showToast("Job gespeichert");
      form.reset();
      await refreshDashboard();
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

onSubmitJson(document.getElementById("crawl-form"), "/api/jobs/crawl", (data) => ({
  startUrl: data.get("startUrl"),
  maxDepth: Number(data.get("maxDepth") || 0),
  knowledgeBaseId: Number(data.get("knowledgeBaseId") || 0) || null,
  downloadDocuments: data.get("downloadDocuments") === "on",
  downloadImages: data.get("downloadImages") === "on"
}));

onSubmitJson(document.getElementById("sync-form"), "/api/jobs/sync", (data) => ({
  rootDir: data.get("rootDir"),
  knowledgeBaseId: Number(data.get("knowledgeBaseId") || 0) || null
}));

onSubmitJson(document.getElementById("git-form"), "/api/jobs/git-sync", (data) => ({
  repositoryUrl: data.get("repositoryUrl"),
  branch: String(data.get("branch") || "").trim() || null,
  subPath: String(data.get("subPath") || "").trim() || null,
  knowledgeBaseId: Number(data.get("knowledgeBaseId") || 0) || null
}));

onSubmitJson(document.getElementById("schedule-form"), "/api/schedules", (data) => ({
  jobType: data.get("jobType"),
  cronExpression: data.get("cronExpression"),
  payload: data.get("payload") ? JSON.parse(data.get("payload")) : {}
}));

document.getElementById("upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const formData = new FormData(form);
    await requestJson("/api/upload", { method: "POST", body: formData });
    showToast("Upload in Queue gelegt");
    form.reset();
    await refreshDashboard();
  } catch (error) {
    showToast(error.message, true);
  }
});

documentFiltersFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  state.documentsPage = 1;
  state.filters = {
    query: String(data.get("query") || "").trim(),
    category: String(data.get("category") || "").trim(),
    sourceType: String(data.get("sourceType") || "").trim(),
    documentType: String(data.get("documentType") || "").trim(),
      limit: Number(data.get("limit") || 25)
  };

  try {
    await loadDocuments();
  } catch (error) {
    showToast(error.message, true);
  }
});

const documentAdminResetEl = document.getElementById("document-admin-reset");
if (documentAdminResetEl) {
  documentAdminResetEl.addEventListener("click", async () => {
    documentFiltersFormEl.reset();
    state.documentsPage = 1;
    state.filters = {
      query: "",
      category: "",
      sourceType: "",
      documentType: "",
      limit: 25
    };

    try {
      await loadDocuments();
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

documentPreviewFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadDocumentPreview(new FormData(event.currentTarget).get("documentId"));
});

if (knowledgeBaseFormEl) {
  knowledgeBaseFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const payload = {
        name: String(data.get("name") || "").trim(),
        slug: String(data.get("slug") || "").trim(),
        description: String(data.get("description") || "").trim(),
        isEnabled: Boolean(data.get("isEnabled"))
      };
      const method = state.editingKnowledgeBaseId ? "PATCH" : "POST";
      const url = state.editingKnowledgeBaseId
        ? `/api/admin/knowledge-bases/${state.editingKnowledgeBaseId}`
        : "/api/admin/knowledge-bases";
      await requestJson(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      showToast(state.editingKnowledgeBaseId ? "Wissensdatenbank aktualisiert" : "Wissensdatenbank angelegt");
      resetKnowledgeBaseForm();
      await loadKnowledgeBases();
      renderRagfindSettings();
      await loadMcpPrincipals();
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

if (knowledgeBaseResetEl) {
  knowledgeBaseResetEl.addEventListener("click", () => resetKnowledgeBaseForm());
}

if (mcpPrincipalFormEl) {
  mcpPrincipalFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const payload = {
        name: String(data.get("name") || "").trim(),
        description: String(data.get("description") || "").trim(),
        isEnabled: Boolean(data.get("isEnabled")),
        knowledgeBaseIds: getSelectedKnowledgeBaseIdsFromForm()
      };
      const method = state.editingPrincipalId ? "PATCH" : "POST";
      const url = state.editingPrincipalId
        ? `/api/admin/mcp-principals/${state.editingPrincipalId}`
        : "/api/admin/mcp-principals";
      const response = await requestJson(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!state.editingPrincipalId && mcpTokenOutputEl && response.token) {
        mcpTokenOutputEl.classList.remove("hidden");
        mcpTokenOutputEl.textContent = `Neues Token fuer ${response.principal.name}:\n\n${response.token}`;
      }
      showToast(state.editingPrincipalId ? "MCP-Zugang aktualisiert" : "MCP-Zugang angelegt");
      resetPrincipalForm();
      await loadMcpPrincipals();
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

if (mcpPrincipalResetEl) {
  mcpPrincipalResetEl.addEventListener("click", () => resetPrincipalForm());
}

if (adminPasswordFormEl) {
  adminPasswordFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const payload = {
        currentPassword: String(data.get("currentPassword") || ""),
        newPassword: String(data.get("newPassword") || ""),
        confirmPassword: String(data.get("confirmPassword") || "")
      };

      await requestJson("/api/admin/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      adminPasswordFormEl.reset();
      showToast("Admin-Passwort geaendert. Seite wird neu geladen, danach bitte mit dem neuen Passwort anmelden.");
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

if (adminUserFormEl) {
  adminUserFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const payload = {
        username: String(data.get("username") || "").trim(),
        password: String(data.get("password") || ""),
        confirmPassword: String(data.get("confirmPassword") || "")
      };

      await requestJson("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      adminUserFormEl.reset();
      showToast("Admin-Benutzer angelegt");
      await loadAdminUsers();
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

if (elasticsearchReindexEl) {
  elasticsearchReindexEl.addEventListener("click", async () => {
    const originalLabel = elasticsearchReindexEl.textContent;
    elasticsearchReindexEl.disabled = true;
    elasticsearchReindexEl.textContent = "Reindex laeuft...";

    try {
      const result = await requestJson("/api/admin/search/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchSize: 100 })
      });
      showToast(`Elasticsearch-Reindex abgeschlossen (${result.processed} Dokumente)`);
      await refreshDashboard();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      elasticsearchReindexEl.disabled = false;
      elasticsearchReindexEl.textContent = originalLabel;
    }
  });
}

if (forceReembedEl) {
  forceReembedEl.addEventListener("click", async () => {
    if (!window.confirm("Alle Vektoren neu berechnen? Das laeuft im Hintergrund und kann je nach Bestand lange dauern.")) {
      return;
    }

    const originalLabel = forceReembedEl.textContent;
    forceReembedEl.disabled = true;
    forceReembedEl.textContent = "Job wird eingereiht...";

    try {
      const result = await requestJson("/api/admin/embeddings/reembed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true })
      });
      showToast(`Re-Embedding eingereiht (Job ${result.jobId}, Modell ${result.targetModel})`);
      await refreshDashboard();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      forceReembedEl.disabled = false;
      forceReembedEl.textContent = originalLabel;
    }
  });
}

if (classificationReindexEl) {
  classificationReindexEl.addEventListener("click", async () => {
    const originalLabel = classificationReindexEl.textContent;
    classificationReindexEl.disabled = true;
    classificationReindexEl.textContent = "Backfill laeuft...";

    try {
      const result = await requestJson("/api/admin/classification/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchSize: 25 })
      });
      showToast(`Klassifizierung abgeschlossen (${result.classified} klassifiziert, ${result.skipped} uebersprungen, ${result.failed} fehlgeschlagen)`);
      await refreshDashboard();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      classificationReindexEl.disabled = false;
      classificationReindexEl.textContent = originalLabel;
    }
  });
}

for (const button of viewNavButtons) {
  button.addEventListener("click", () => navigateToView(button.dataset.view));
}

window.addEventListener("hashchange", () => setActiveView(getViewFromHash()));
setActiveView(getViewFromHash());

if (adminAccessToggleEl) {
  adminAccessToggleEl.addEventListener("click", () => navigateToView("system"));
}

if (settingsToggleEl) {
  settingsToggleEl.addEventListener("click", () => navigateToView("wissensbasis"));
}

if (ragfindSettingsFormEl) {
  ragfindSettingsFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const selectedKnowledgeBaseIds = [...ragfindSettingsFormEl.querySelectorAll("input[name='ragfindKnowledgeBaseIds']:checked")]
        .map((input) => Number(input.value))
        .filter((value) => Number.isFinite(value) && value > 0);

      const settings = await requestJson("/api/admin/ragfind/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeBaseIds: selectedKnowledgeBaseIds })
      });

      releaseForm(ragfindSettingsFormEl);
      renderRagfindSettings(settings);
      showToast("RAGfind-Konfiguration gespeichert");
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

if (aiProviderSelectEl) {
  aiProviderSelectEl.addEventListener("change", updateAiProviderApiKeyVisibility);
}

if (aiProviderLoadModelsEl) {
  aiProviderLoadModelsEl.addEventListener("click", () => {
    loadAiProviderModelOptions();
  });
}

if (aiProviderSettingsFormEl) {
  aiProviderSettingsFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(aiProviderSettingsFormEl);
      const payload = {
        provider: String(data.get("provider") || "ollama"),
        baseUrl: String(data.get("baseUrl") || "").trim(),
        apiKey: String(data.get("apiKey") || ""),
        embeddingModel: String(data.get("embeddingModel") || "").trim(),
        summaryModel: String(data.get("summaryModel") || "").trim(),
        classifierModel: String(data.get("classifierModel") || "").trim(),
        rerankerEnabled: data.get("rerankerEnabled") === "on",
        rerankerBaseUrl: String(data.get("rerankerBaseUrl") || "").trim(),
        rerankerModel: String(data.get("rerankerModel") || "").trim(),
        rerankerTopN: Number(data.get("rerankerTopN") || 12),
        clearApiKey: data.get("clearApiKey") === "on"
      };

      const settings = await requestJson("/api/admin/ai-provider/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      releaseForm(aiProviderSettingsFormEl);
      renderAiProviderSettings(settings);
      showToast("KI-Provider-Konfiguration gespeichert");
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

analysisButtons.forEach((button) => {
  button.addEventListener("click", () => runAnalysis(button.dataset.analysis));
});

document.getElementById("query-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = new FormData(event.currentTarget);
    const category = String(data.get("category") || "").trim();
    const documentType = String(data.get("documentType") || "").trim();
    const result = await requestJson("/api/smart-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: data.get("query"),
        category: category || undefined,
        documentType: documentType || undefined
      })
    });
    queryResultEl.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById("refresh-all").addEventListener("click", () => {
  refreshDashboard().catch((error) => showToast(error.message, true));
});

themeToggleEl.addEventListener("click", () => {
  setTheme(getTheme() === "dark" ? "light" : "dark");
});

updateThemeToggle();
updateAnalysisButtons();
// Diese Bereiche enthalten Eingaben, die eine Hintergrund-Aktualisierung nicht
// ueberschreiben darf (siehe isBeingEdited).
watchFormEdits(aiProviderSettingsFormEl);
watchFormEdits(ragfindSettingsFormEl);
watchFormEdits(documentTypeSettingsEl);

refreshDashboard().catch((error) => showToast(error.message, true));
setInterval(() => refreshDashboard().catch(() => undefined), 20000);
