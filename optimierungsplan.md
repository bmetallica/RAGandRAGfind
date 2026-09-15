# Optimierungsplan Retrieval-Qualität

Stand: 2026-08-26

## Ausgangslage

Die Architektur ist tragfähig (async Embedding-Pipeline, KB-Isolation mit ACLs, typabhängiges
Chunking, Small-to-Big, Section-Verlinkung, MCP-Layer). Die Schwächen liegen ausschließlich in der
Retrieval-Qualitätsschicht:

| # | Befund | Fundstelle |
|---|--------|-----------|
| 1 | Kein Cross-Encoder-Reranker, stattdessen ~30 handgetunte Magic Numbers | `src/routes/api.ts:405` `calculateRerankScore` |
| 2 | Embedding ohne Task-Prefix (`search_document:` / `search_query:`) | `src/services/aiProviderClient.ts:99` |
| 3 | Volltext auf `to_tsvector('simple', …)` — kein deutsches Stemming; ES ohne deutschen Analyzer | `migrations/015_materialized_search_fields.sql`, `src/services/searchIndexService.ts:118` |
| 4 | Embeddet wird nur `content`, ohne Dokument-/Section-Kontext | `src/services/embeddingPendingService.ts:31` |
| 5 | Kein Goldenset, keine Metriken — Tuning ist nicht falsifizierbar | — |
| 6 | Ohne Elasticsearch Full-Scan mit Trigram-`similarity()` pro Query | `src/routes/api.ts:1290` `document_signals` |

## Reihenfolge und Begründung

Phase 0 zuerst, weil ohne Messung jede folgende Phase Bauchgefühl bleibt. Phase 1 und 2 werden
gemeinsam ausgerollt, weil beide einen Reindex bzw. Re-Embed des Bestands auslösen — ein Durchlauf
statt zwei. Phase 3 ist der größte Einzelgewinn, hängt aber an einem Modell, das du bereitstellen
musst. Phase 4 ist reine Latenz, unabhängig vom Rest. Phase 5 ist optional.

| Phase | Inhalt | Status |
|-------|--------|--------|
| 0 | Goldenset + Eval-Runner | ✅ ausgerollt, 24 Fragen aus dem echten Bestand |
| 1 | Deutsche Textkonfiguration (Postgres + Elasticsearch) | ✅ ausgerollt und gemessen |
| 2 | Kontext-Header + Task-Prefixes beim Embedding | ✅ ausgerollt und gemessen |
| 3 | Cross-Encoder-Reranker (Qwen3-Reranker-0.6B) | ✅ ausgerollt und gemessen |
| 4 | Kandidatenmenge früher begrenzen | ✅ ausgerollt und gemessen |
| 5 | Embedding-Modell-Wechsel (optional) | offen — braucht ein neues Modell ⛔ |

## Ergebnis des Rollouts

Gemessen mit `npm run eval` über 24 inhaltliche Fragen aus dem eigenen Bestand (228 Dokumente,
2753 Chunks), `topK = 10`:

| | Baseline | +Phase 1+2 | +Phase 3 | +Phase 4 | +voller Kontext |
|---|---:|---:|---:|---:|---:|
| **nDCG@10** | 0.523 | 0.747 | 0.789 | 0.789 | **0.798** |
| Recall@10 | 0.542 | 0.813 | 0.813 | 0.813 | 0.813 |
| MRR | 0.521 | 0.744 | 0.792 | 0.792 | **0.813** |
| Precision@1 | 0.500 | 0.708 | 0.750 | 0.750 | **0.792** |
| Totalausfälle (von 24) | 11 | 4 | 4 | 4 | 4 |
| Latenz p50 | 724 ms | 893 ms | 1186 ms | 763 ms | 883 ms |
| Latenz p95 | 1059 ms | 1212 ms | 1948 ms | 1306 ms | 1493 ms |

Unterm Strich **+53 % nDCG bei +22 % Latenz p50**. Die Ergebnisdateien liegen in `eval/results/`.

Was welche Phase gebracht hat:

- **Phase 1+2** trägt den Großteil: sieben Fragen gingen von 0 auf einen Treffer, darunter
  „Welche Abzeichen gehören auf die Klappen der Brusttaschen?" (Plural in der Frage, Singular im
  Dokument — genau der Stemming-Fall) und „Was kosten Weinbergschnecken als Vorspeise?".
- **Phase 3** verbessert die Reihenfolge, nicht die Trefferliste: Recall unverändert, aber MRR
  +0.047 und Precision@1 +0.042. Drei Fragen rückten von Rang 3–5 auf Rang 1, eine
  (`heimdall-version`, erwartet zwei Dokumente) fiel von 0.920 auf 0.693.
- **Phase 4** verändert die Qualität um exakt null und macht die Suche um 36 % schneller.
- **Voller Kontext** (nach Anpassung des Modellservers, siehe unten) heilt die einzige Regression
  aus Phase 3: `heimdall-version` geht von 0.693 zurück auf 0.920, weil der Reranker jetzt das
  vollständige README bewertet statt der ersten 900 Zeichen. Dazu P@1 +0.042.

### Kandidatenzahl des Rerankers

Mit vollständigen Passagen kostete `top_n = 12` spürbar Latenz (p95 2271 ms). Ein Vergleichslauf mit
`top_n = 8` liefert **exakt dieselben Metriken** (keine einzige Frage verändert sich um mehr als
0.01 nDCG) bei p95 1493 ms. Diese Installation läuft deshalb auf 8; der Code-Default bleibt bei 12,
weil der richtige Wert vom Bestand abhängt und nur ein Eval-Lauf ihn bestimmen kann.

### Vier Fragen bleiben Totalausfälle

`verein-registergericht`, `festival-vorstandsrunde`, `kuchenliste-rotwein`, `raspberry-gpio`.
Gemeinsamer Nenner: die Antwort steht in einer OCR-Tabelle oder einem Layoutfragment ohne
Fließtext, in dem die Frage-Begriffe gar nicht vorkommen („Vorstandsrunde" steht im Aufbauplan als
Zelle in einem Wochenraster). Das ist kein Ranking-, sondern ein Extraktionsproblem — der nächste
sinnvolle Hebel wäre besseres Tabellen-Handling bei der Extraktion, nicht weiteres Retrieval-Tuning.

### Rollout für Phase 1 – 3


Der Reranker (Phase 3) ist beim Deploy noch aus und wird erst am Ende zugeschaltet — so lässt sich
sein Beitrag getrennt von Phase 1 + 2 messen.

1. Deploy des neuen Codes
2. `npm run migrate` — legt die deutschen tsvector-Spalten (021), `embedding_input_version` (022)
   und die Reranker-Konfiguration (023) an
3. `npm run eval -- --tag baseline` **vor** dem Reindex, solange die alten Vektoren noch stehen
4. Admin-UI → *Reindex starten* (Elasticsearch, füllt die neuen `-v2`-Indizes)
5. Admin-UI → *Re-Embedding starten* (Config-AI) — baut alle Vektoren mit Kontext-Header und Task-Prefix neu auf
6. `npm run eval -- --tag phase1-2 --baseline eval/results/baseline.json`
7. Admin-UI → Config-AI → *Cross-Encoder-Reranker verwenden* aktivieren
   (URL `http://<reranker-host>:8080`, Modell `Qwen3-Reranker-0.6B`), speichern
8. `npm run eval -- --tag phase3 --baseline eval/results/phase1-2.json`

Schritt 3 ist der Punkt, an dem der Vorher-Zustand festgehalten wird — ohne ihn ist der Effekt
von Phase 1 + 2 nicht mehr messbar. Die alten Elasticsearch-Indizes (`rag-documents`, `rag-chunks`
ohne Versionssuffix) können nach Schritt 4 von Hand gelöscht werden.

Alternativ lassen sich Schritte 1–2 und 7 über `.env` bündeln
(`RERANKER_BASE_URL`, `RERANKER_MODEL`, `RERANKER_ENABLED=true`); diese Werte werden aber nur
einmalig in die Datenbank übernommen, solange dort noch keine Reranker-URL steht.

---

## Phase 0 — Messbarkeit

**Ziel:** Jede spätere Änderung wird gegen dieselben Fragen gemessen, statt gegen Eindruck.

**Neu: `eval/goldenset.json`**

```jsonc
{
  "queries": [
    {
      "id": "dienstplan-2017",
      "query": "Wer hatte im Mai Dienst am Ausschank?",
      "knowledgeBase": "default",          // optional
      "expectedDocuments": ["Dienstplan_2017"],  // Teilstring des sourceRef
      "expectedSnippets": ["Ausschank"] // optional, prueft die Chunk-Genauigkeit
    }
  ]
}
```

**Neu: `src/eval/runEval.ts`, aufrufbar über `npm run eval`**

- Läuft gegen die laufende DB über `executeSmartSearchQuery` — also exakt den Pfad, den RAGfind
  und MCP benutzen, inklusive Reranking und Small-to-Big.
- Metriken pro Query und aggregiert: `Recall@k`, `MRR`, `nDCG@k`, `Precision@1`, dazu die bereits
  vorhandenen Stufen-Timings aus `executeSimilarityQuery`.
- `--baseline eval/results/<name>.json` vergleicht gegen einen früheren Lauf und zeigt pro Query,
  was besser und was schlechter wurde. Regressionen sind damit sichtbar, nicht nur Mittelwerte.
- `--tag <name>` schreibt das Ergebnis nach `eval/results/<name>.json`.

**Neu: `src/eval/bootstrapGoldenset.ts` (`npm run eval:bootstrap`)** — zieht eine Stichprobe echter
Dokumente aus der DB und schreibt ein vorausgefülltes Template, damit die Fragen nur noch ergänzt
werden müssen.

**Deine Aufgabe:** 30–100 echte Fragen eintragen. Weniger als ~30 rauscht zu stark. Der Runner
funktioniert auch mit weniger, die Aussagekraft steigt aber deutlich ab ca. 50.

---

## Phase 1 — Deutsche Textkonfiguration

### 1a) PostgreSQL

Aktuell: `to_tsvector('simple', …)` in `migrations/015`. „Dienstplan" findet kein „Dienstpläne".
Genau deshalb existiert die handgeschriebene Suffix-Heuristik `buildDocumentLocatorTerms`
(`src/services/documentService.ts:23`), die schlechtes Stemming nachbaut.

**Nicht** ersetzen, sondern **ergänzen** — `simple` bleibt für exakte Treffer auf Aktenzeichen,
Artikelnummern und Dateinamen unverzichtbar.

**Neu: `migrations/021_german_text_search.sql`**

- `documents.search_lookup_tsv_de` (GENERATED, `to_tsvector('german', title/source_ref)` mit
  denselben Gewichten A/B)
- `document_chunks.search_content_tsv_de` (GENERATED, `to_tsvector('german', content)`)
- `document_sections.search_tsv_de` (GENERATED)
- je ein GIN-Index darauf

Kein `unaccent` in den generated columns — `unaccent()` ist `STABLE`, nicht `IMMUTABLE`, und
funktioniert dort nur über einen Wrapper-Hack. Der deutsche Snowball-Stemmer deckt Umlaute
ausreichend ab.

### 1b) Query-Anpassung in `src/routes/api.ts`

- `query_search` liefert zusätzlich `tsquery_de` (`to_tsquery('german', …)`).
- `chunk_keyword_matches` / `document_keyword_matches`: `WHERE tsv @@ q OR tsv_de @@ q_de`,
  Score `GREATEST(ts_rank_cd(tsv, q), ts_rank_cd(tsv_de, q_de))`.
- `refineNarrativeSectionsWithinDocument` und `refineItemsWithinDocument` analog.
- `buildDocumentLocatorTerms` bleibt zunächst als Fallback stehen und wird erst entfernt, wenn
  Phase 0 zeigt, dass die deutsche Konfiguration sie ersetzt.

### 1c) Elasticsearch

`ensureIndices` (`src/services/searchIndexService.ts:110`) legt die Indizes ohne `settings` an, also
mit dem `standard`-Analyzer. Für deutschen Bestand fehlen Normalisierung, Kompositazerlegung und
Stemming.

- Index-`settings` mit Analyzer `german_rag`: `lowercase` → `german_normalization` →
  `german_stop` → `light_german` (Stemmer).
- Textfelder als Multi-Field: `content` (standard, exakt) + `content.de` (german_rag).
- `searchChunkCandidates` / `searchDocumentCandidates` durchsuchen beide Varianten.
- **Mapping-Änderungen greifen nicht auf bestehenden Indizes** (`ensureIndices` schluckt 400).
  Deshalb: Indexnamen auf `${prefix}-documents-v2` / `${prefix}-chunks-v2` versionieren. Der
  bestehende Button *Elasticsearch-Reindex* im Admin-UI füllt sie neu. Die alten Indizes können
  danach von Hand gelöscht werden.

### Rollout Phase 1

1. `npm run migrate` (schreibt die neuen generated columns — Tabellen-Rewrite, bei eurem Bestand
   unkritisch)
2. Admin-UI → *Elasticsearch-Reindex*
3. `npm run eval --tag phase1`

---

## Phase 2 — Kontext und Task-Prefixes beim Embedding

### 2a) Task-Prefixes

`nomic-embed-text` ist mit `search_document:` / `search_query:` trainiert. Ohne Prefix liegen
Dokument- und Query-Vektoren im falschen Teilraum — das kostet messbar Trefferqualität, und zwar
ohne dass irgendetwas offensichtlich kaputt aussieht.

**Neu: `src/services/embeddingInputService.ts`**

```ts
export type EmbeddingTask = "document" | "query";
export function applyEmbeddingTaskPrefix(model: string, task: EmbeddingTask, text: string): string
```

Ableitung aus dem Modellnamen, weil das Modell im Admin-UI wechselbar ist:

| Modellfamilie | document | query |
|---------------|----------|-------|
| `nomic-embed*` | `search_document: ` | `search_query: ` |
| `*e5*` (multilingual-e5, e5-*) | `passage: ` | `query: ` |
| `bge-m3`, `jina-embeddings-v3`, `qwen3-embedding` | — | — |
| unbekannt | — | — |

Override über `EMBEDDING_DOCUMENT_PREFIX` / `EMBEDDING_QUERY_PREFIX` in `.env` (leer = automatisch),
damit ein exotisches Modell nicht am Namensmuster scheitert.

### 2b) Kontext-Header am Chunk

Aktuell wird ausschließlich `content` embeddet. Dokumenttitel und `sectionTitle` liegen bereits im
Chunk-Metadata (`documentService.ts:536`) — sie voranzustellen kostet nichts und ist ein bekannter,
großer Recall-Gewinn, gerade bei kurzen Chunks aus Tabellen und Dienstplänen.

```ts
export function buildDocumentEmbeddingInput(input: {
  documentTitle: string | null;
  sectionTitle: string | null;
  content: string;
}): string
```

Ergebnisform: `"<Titel> — <Abschnitt>\n\n<content>"`, Header nur wenn vorhanden und nicht bereits
wörtlich im Chunk enthalten. Der Header geht **nur** in den Embedding-Input, nicht in
`document_chunks.content` — die Anzeige und der Volltext bleiben unverändert.

### 2c) Betroffene Stellen

- `src/services/vectorService.ts`: `embedDocuments(inputs)` / `embedQuery(text)` statt des heute
  task-blinden `embed()`. `embed()` bleibt für `probeEmbeddingDimension` erhalten.
- `src/services/embeddingPendingService.ts`: SELECT um `d.title` und
  `s.title AS section_title` erweitern (JOIN auf `documents` / `document_sections`), Input über
  `buildDocumentEmbeddingInput` bauen.
- `src/services/reembeddingService.ts`: identisch — sonst hätte ein Re-Embed andere Vektoren als
  eine frische Ingestion.
- `src/routes/api.ts:1216`: Query-Embedding über `embedQuery`.

### Rollout Phase 2

1. Deploy
2. Admin-UI → *Re-Embedding* auf dasselbe Modell — erzwingt den Neuaufbau aller Vektoren
   ⚠️ `ReembeddingService` selektiert `WHERE embedding_model != $1`. Bei gleichem Modell findet er
   nichts. Der Service bekommt dafür ein `force`-Flag, das stattdessen nach
   `embedding_input_version != <aktuell>` selektiert. Neue Spalte in `migrations/022`.
3. `npm run eval --tag phase2`

---

## Phase 3 — Cross-Encoder-Reranker ⛔ braucht deine Bereitstellung

**Der größte Einzelgewinn.** `rerankItems` (`api.ts:485`) ist eine lexikalische Heuristik mit
Sonderfällen wie `isSoftwareDescriptionQuestion`. Ein Cross-Encoder sieht Query und Passage
gemeinsam und ersetzt das komplette Konstrukt.

### Verwendeter Endpunkt

`Qwen3-Reranker-0.6B` läuft bereits über llama-swap auf `http://<reranker-host>:8080/v1/rerank`
(„Reranker fuer RAG (/v1/rerank), laeuft permanent parallel"). Verifiziert mit einer deutschen
Testanfrage: die beiden Dienstplan-Passagen bekommen 1.00 und 0.98, Lizenztext und Rechnung
0.0004 bzw. 0.004 — die Trennschärfe ist genau das, was der lexikalischen Heuristik fehlt.

**Gemessene Latenz** (Qwen3-Reranker-0.6B, ~1200 Zeichen je Dokument): 8 Kandidaten ~740 ms,
12 ~1090 ms, 20 ~1800 ms — die Kosten wachsen linear mit der Anzahl gesendeter Kandidaten. Zum
Vergleich: eine Suche ohne Reranker lag im Smoke-Test bei 300–840 ms. Der Default steht deshalb
auf `top_n = 12`; ob 20 die Mehrlatenz wert sind, entscheidet der Eval-Lauf aus Phase 0.

Der Client spricht `POST /v1/rerank`
(`{model, query, documents: string[], top_n}` → `{results: [{index, relevance_score}]}`) mit
Fallback auf `/rerank`. Dasselbe Schema liefern TEI, Infinity und vLLM, ein Wechsel des
Reranking-Servers braucht also keine Codeänderung.

### Was ich dann baue

**`migrations/023_reranker_settings.sql`** — `ai_provider_settings` um `reranker_enabled`,
`reranker_base_url`, `reranker_model`, `reranker_top_n` erweitern.

**`src/services/rerankerService.ts`**

- HTTP-Client gegen `/v1/rerank` mit Fallback auf `/rerank`
- Timeout, Health-Check und Semaphore analog `VectorService` — der Reranker sitzt im
  Query-Pfad, ein hängender Endpunkt darf die Suche nicht blockieren
- **Fällt bei Fehler oder deaktivierter Konfiguration auf die heutige Heuristik zurück.** Die Suche
  funktioniert also weiter, wenn der Reranker aus ist

**Integration in `executeSimilarityQuery`** (`api.ts:1714`): eine Stelle. Aus

```ts
const rerankedItems = searchOptions?.enableRerank === false
  ? combinedSmartItems
  : rerankItems(combinedSmartItems, rerankQuery, effectiveSearchOptions);
```

wird ein Aufruf, der zuerst den Cross-Encoder versucht und nur bei dessen Ausfall
`rerankItems` benutzt. `enableRerank === false` bleibt Bypass. Da RAGfind und MCP über
`executeSmartSearchQuery` denselben Pfad nutzen, profitieren beide ohne eigene Änderung.

**Admin-UI:** Reranker-Felder im Bereich *Config-AI*, plus Reachability-Anzeige wie beim
AI-Provider.

**Score-Skalierung:** Die Relevanzwerte (0..1) werden nicht roh übernommen, sondern auf die
Score-Spanne abgebildet, die der Kopf der Trefferliste ohnehin hatte (Mindestspanne 2). Grund:
`applyAdjacentSectionBias` addiert und subtrahiert absolute Boni (+3 bis −8), die auf die
Fusions-Skala getunt sind — ein roher 0..1-Score würde von diesen Boni vollständig überstimmt.

**Erwarteter Effekt:** Der aggressive Dominanz-Filter (`api.ts:1690`, verwirft bei
`documentMatchScore >= 2` alles außer dem Top-Dokument) wird überflüssig und kann anschließend
zurückgebaut werden — er kostet heute Recall bei Fragen über mehrere Dokumente. Dieser Rückbau
gehört hinter Schritt 8 des Rollouts, damit der Eval-Lauf ihn absichert.

---

## Phase 4 — Kandidatenmenge früher begrenzen ✅

Beim Profilieren kamen drei Ursachen zusammen, zwei davon waren nicht im ursprünglichen Plan:

**1. Der HNSW-Index wurde nie benutzt.** `vector_candidates` sortierte nach
`c.embedding <=> q.embedding`, wobei `q.embedding` aus der CTE `query_input` kam. pgvector erkennt
ein `ORDER BY` nur dann als Index-Scan, wenn der Operand eine Konstante oder ein Parameter ist —
eine Spalte aus einer gejointen Relation macht daraus einen Seq Scan mit einer Distanzberechnung
pro Chunk. Mit `$1::vector` direkt in der Query: Index-Scan, 40 Zeilen in 1,5 ms statt 2753 Zeilen
sequenziell.

**2. Ein toter, teurer Funktionsaufruf.** Das Dokumentsignal berechnete
`GREATEST(similarity(term, ref), word_similarity(term, ref), similarity(term, text), word_similarity(term, text))`.
Der dritte Aufruf vergleicht einen Suchbegriff mit den ersten 16 000 Zeichen des Dokuments *als
Ganzes* — die Trigramm-Überlappung ist verschwindend. Gemessen über diesen Bestand: Maximum 0.030,
während `word_similarity` auf demselben Text 1.0 erreicht und die Schwelle für einen Fuzzy-Treffer
bei 0.60 liegt. Er konnte das `GREATEST` also nie gewinnen, kostete aber 84 ms je Suchbegriff über
den Bestand. Entfernt.

**3. Alles doppelt gerechnet.** Dasselbe `GREATEST` stand einmal im `COUNT(*) FILTER` und einmal in
der `SUM(CASE ...)` — zwei Auswertungen pro Dokument und Suchbegriff. Jetzt einmal in einer
Unterabfrage, dann aggregiert.

Dazu die ursprünglich geplante Umstellung: die Dokumentsignale laufen nur noch über die Vereinigung
aus Vektor- und Keyword-Kandidaten (`signal_scope`) statt über den gesamten Bestand, und der
unscharfe Trigramm-Abgleich schaut nur noch in die ersten `QUERY_FUZZY_TEXT_WINDOW` Zeichen
(Default 4000). Exakte Treffer nutzen weiterhin die vollen 16k.

**Wichtig für die Sicherheit:** Die Wissensdatenbank-Beschränkung hing bisher indirekt am
`document_signals`-Join. Da die Signale jetzt hinter der Kandidatenauswahl stehen, ging das nicht
mehr — die ACL-Grenze ist deshalb in eine eigene CTE `scoped_documents` gewandert, die jede
Kandidatenquelle joint. Nachgeprüft: eine Suche mit `allowedKnowledgeBaseIds` liefert keine
Dokumente außerhalb der erlaubten Wissensdatenbanken, eine unbekannte oder leere Liste liefert
nichts.

**Messung** (`EXPLAIN ANALYZE`, echter Bestand, Elasticsearch-Kandidaten aus — der Fall, den diese
Phase adressiert): 1890 ms → 495 ms reine SQL-Zeit, Ende-zu-Ende p50 1186 ms → 763 ms, bei
unveränderter Trefferqualität.

## Modellserver: Eingabelimits

Beim Rollout stellte sich heraus, dass llama.cpp jede einzelne Embedding- und Reranking-Eingabe auf
`n_ubatch` begrenzt — Default **512 Token**. Bei Embeddings mit Pooling muss die gesamte Sequenz in
**einen** ubatch, sie lässt sich nicht aufteilen; `--ctx-size` hilft dagegen nicht. `CHUNK_SIZE`
schützt ebenfalls nicht, weil es mit `gpt-tokenizer` zählt, während deutscher Text im Modell-
Tokenizer rund doppelt so dicht kodiert.

Gemessen an diesem Bestand (längster Chunk 1440 Zeichen, Eingabe inkl. Kontext-Header und Prefix
~1707 Zeichen):

| Textart | Zeichen/Token | Token im Worst Case |
|---|---:|---:|
| dichteste OCR-Tabelle | 2,68 | 637 |
| deutscher Fließtext | 2,99 | 572 |
| Quellcode | 3,51 | 487 |

Nach der Serveranpassung (`--ubatch-size 2048`, 2048 Token Kontext je Slot) nimmt der
Embedding-Endpunkt ~6100 Zeichen und der Reranker ~7200 — beides ein Vielfaches des Worst Case.
Die App-seitigen Deckel stehen deshalb in `.env` auf `EMBEDDING_MAX_INPUT_CHARS=5000` und
`RERANKER_DOCUMENT_MAX_CHARS=2500` und greifen im Normalbetrieb nie. Die Code-Defaults bleiben bei
1400 bzw. 900, damit ein llama.cpp mit unverändertem `ubatch`-Default direkt funktioniert.

Unabhängig davon reagiert der Stack auf eine Ablehnung selbst: der Batch wird aufgeteilt, der
auffällige Eintrag schrittweise gekürzt und erneut geschickt. Das ist tokenizer-unabhängig und
überlebt einen Modellwechsel.

**Wichtig, weil es leicht zu verwechseln ist:** Ein ganzes Buch geht nie an den Server. Gechunkt
wird in Node, bevor ein Modell angefasst wird — ein Roman im Bestand liegt als gut 600 Chunks vor, der
Embedder sieht immer nur einen davon.

## Provider-Kompatibilität

Der Stack spricht mit jedem OpenAI-kompatiblen Server — vLLM, llama.cpp/llama-swap, LM Studio, TGI.
Drei Dinge standen dem im Weg und sind behoben:

1. **Der API-Key war Pflicht.** `updateAiProviderSettings` lehnte einen `openai`-Provider ohne
   Schlüssel ab, weshalb hier ein achtstelliger Dummy-Wert für llama-swap eingetragen war. Lokale
   Server laufen ohne Authentifizierung; der Schlüssel ist jetzt optional und über eine Checkbox im
   Admin-UI auch wieder entfernbar (vorher hieß ein leeres Feld „behalten", es gab keinen Weg
   zurück). Der Dummy-Key dieser Installation ist entfernt.
2. **`response_format: json_object`** wird nicht von jedem Server unterstützt — vLLM braucht dafür
   ein Guided-Decoding-Backend, ältere Builds lehnen das Feld ab. Wird es abgelehnt, läuft die
   Anfrage jetzt automatisch ohne dieses Feld noch einmal; die Klassifikation funktioniert dadurch
   auch ohne Guided Decoding.
3. **Reasoning-Modelle** liefern über vLLM ihre Ausgabe in `reasoning_content` und lassen `content`
   leer. Das galt bisher als leere Antwort und ließ die Klassifikation scheitern.

Nicht angepasst werden musste: Endpunkt-Pfade, Batch-Embeddings, Dimensionsprüfung, Rerank-Format
und die Erkennung zu langer Eingaben (vLLMs Wortlaut „maximum context length" war bereits abgedeckt).

**`npm run check:provider`** prüft einen Endpunkt mit genau den Client-Codepfaden der Anwendung und
gibt am Ende die Werte für *Config-AI* aus. Gegen den laufenden llama-swap dieser Installation
laufen alle elf Prüfungen grün; für vLLM konnte ich mangels Instanz nur die API-Kompatibilität
herleiten, nicht messen — dafür ist das Werkzeug da.

## Phase 5 — Embedding-Modell (optional) ⛔ braucht deine Bereitstellung

`nomic-embed-text` (768d) ist 2024er Stand und englischlastig. Für deutschen Bestand deutlich
besser:

| Modell | Dim | Anmerkung |
|--------|-----|-----------|
| `bge-m3` | 1024 | mehrsprachig, robust, gut verfügbar als GGUF |
| `multilingual-e5-large-instruct` | 1024 | braucht `query:`/`passage:` — Phase 2 deckt das ab |
| `Qwen3-Embedding-0.6B` | 1024 | stärkste Qualität, höchste Last |

**Nötig:** Modell bereitstellen, `ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(1024)`,
HNSW-Index neu bauen, vollständiges Re-Embed. Der `probeEmbeddingDimension`-Pfad im Admin-UI prüft
die Dimension bereits vor dem Übernehmen.

Erst nach Phase 0–3 sinnvoll — sonst ist nicht unterscheidbar, ob der Gewinn vom Modell oder von
den vorherigen Phasen kommt.

---

## Was ich bewusst nicht anfasse

- **Fusion `w/(20+rank)`** — legitime gewichtete RRF-Variante, funktioniert
- **pgvector + HNSW mit `vector_cosine_ops`** — korrekt konfiguriert
- **Embedding außerhalb der Ingest-Transaktion** — richtige Entscheidung, bleibt
- **`api.ts` mit 4133 Zeilen** — die Retrieval-Pipeline gehört in ein eigenes `retrieval/`-Modul,
  aber ein Refactor ohne Phase 0 im Rücken ist ein unnötiges Risiko. Nach Phase 3 sinnvoll, dann
  ist es durch den Eval-Lauf abgesichert.

---

## Abhängigkeiten auf einen Blick

```
Phase 0 ─┬─> Phase 1 ─┐
         │            ├─> Reindex + Re-Embed ─> Messung
         └─> Phase 2 ─┘
                        └─> Phase 3 (⛔ Reranker-Modell)
                                    └─> Rückbau Dominanz-Filter
Phase 4 unabhängig
Phase 5 nach Phase 3 (⛔ Embedding-Modell)
```
