# Search Performance Tuning Roadmap

## Ziel

Diese Roadmap fokussiert auf die Suchlatenz fuer:

- Ragfind UI
- MCP `search_rag_context`
- MCP `smart_search`
- die gemeinsame Retrieval-Pipeline in der API

Ziel ist nicht nur ein einzelner Fix, sondern eine gestufte Optimierung mit messbaren Zwischenzielen. Die groessten Hebel liegen aktuell in der gemeinsamen Query-Pipeline, nicht im Frontend.

## Kurzfazit

Die Suche ist heute vor allem deshalb langsam, weil pro Anfrage mehrere teure Schritte kombiniert werden:

- externer Embedding-Roundtrip
- Elasticsearch-Kandidatensuche
- grosse PostgreSQL-CTE mit Volltext-, Fuzzy- und Dokumentsignal-Berechnung
- zusaetzliche Refinement-Queries auf Dokument- oder Section-Ebene
- Small-to-big-Kontexterweiterung
- Dateianreicherung und Ragfind-Nachbearbeitung

Der wichtigste Architekturpunkt fuer die Beschleunigung ist:

1. Elasticsearch oder ein anderer Vorfilter muss die Kandidatenmenge wirklich hart begrenzen.
2. PostgreSQL darf danach nur noch auf einem kleinen Kandidatenset reranken.
3. Interaktive Suche braucht einen Fast Path ohne alle teuren Verfeinerungen.

## Aktuelle Hotspots im Code

### 1. Gemeinsame Retrieval-Pipeline

Datei: `src/routes/api.ts`

Kritischer Einstieg:

- `executeSimilarityQuery(...)`

Hauptprobleme dort:

- pro Query wird immer ein Embedding erzeugt
- Elasticsearch-Kandidaten werden zwar geholt, aber nicht hart als SQL-Vorfilter verwendet
- `document_signals` berechnet pro Anfrage dynamische `lower(regexp_replace(...))`, `LIKE`, `similarity(...)`, `word_similarity(...)`
- `left(extracted_text, 16000)` wird pro Query neu normalisiert
- anschliessend kommen weitere Nachstufen wie `refineItemsWithinDocument`, `refineNarrativeSectionsWithinDocument`, `applySmallToBigWithWindow` und `attachOriginalFiles`

Relevante Unterfunktionen in derselben Datei:

- `refineNarrativeSectionsWithinDocument(...)`
- `refineItemsWithinDocument(...)`
- `applySmallToBigWithWindow(...)`
- `attachOriginalFiles(...)`

### 2. Ragfind-spezifischer Suchpfad

Datei: `src/ragfind/server.ts`

Kritische Punkte:

- `buildSearchResults(...)` ruft `executeSmartSearchQuery(...)` auf
- `retrievalTopK` wird aggressiv hochgesetzt: `topK * 6`, Minimum `36`, Maximum `120`
- danach folgen Gruppierung, Snippet-Bildung, Dateianreicherung und bei Bedarf `findSupplementalDocuments(...)`
- `findSupplementalDocuments(...)` nutzt breite `LIKE`-Pruefungen auf `documents.extracted_text`

### 3. Elasticsearch-Nutzung

Datei: `src/services/searchIndexService.ts`

Status heute:

- Elasticsearch wird nur fuer Chunk- und Dokumentkandidaten genutzt
- beide ES-Abfragen laufen bereits parallel
- ES dient aktuell als Zusatzsignal, nicht als echter Gatekeeper
- Mapping ist funktional, aber noch relativ generisch

### 4. Index- und DB-Grundlage

Dateien:

- `migrations/001_init.sql`
- `migrations/002_hybrid_search_indexes.sql`
- `migrations/003_fuzzy_search_indexes.sql`

Status heute:

- pgvector `ivfflat` vorhanden
- GIN-TSV-Index fuer Chunk-Content vorhanden
- GIN-TSV-Index fuer Dokumenttitel plus `source_ref` vorhanden
- Trigram-Index fuer Dokument-Lookup vorhanden

Was fehlt:

- materialisierte Normalisierungsfelder
- materialisierte TSVECTOR-Spalten fuer genau die Queryformen im Code
- klarer Kandidaten-Cut vor aufwendigen Dokumentsignal-Berechnungen
- systematische Messung mit `EXPLAIN ANALYZE`

## Vermutete Hauptursachen fuer hohe Latenz

### A. Kandidatenmenge wird zu spaet begrenzt

Der groesste Architekturfehler ist derzeit, dass PostgreSQL zu viel Arbeit fuer zu viele Dokumente macht.

Elasticsearch liefert zwar Kandidaten, aber die SQL-Pipeline in `executeSimilarityQuery(...)` rechnet trotzdem ueber eine viel zu breite Datenbasis weiter.

### B. Teure String-Normalisierung pro Query

Mehrfach verwendete Muster wie:

- `lower(regexp_replace(...))`
- `LIKE '%' || ... || '%'`
- `similarity(...)`
- `word_similarity(...)`

werden zur Laufzeit auf grossen Textmengen gerechnet. Das ist teuer und teilweise schlecht indexierbar.

### C. Zu viele zweite und dritte Suchstufen im Standardpfad

Fuer viele Anfragen werden aktuell automatisch ausgelost:

- Dokumentfokus-Refinement
- Narrativ-Section-Refinement
- Small-to-big
- Dateianreicherung

Das verbessert Qualitaet, kostet aber fuer interaktive Nutzung viel Zeit.

### D. Ragfind holt fuer Top-K zu viele Rohkandidaten

Fuer UI-Suche ist `topK * 6` mit Mindestwert `36` oft zu teuer. Die meisten Treffer werden spaeter sowieso verworfen.

### E. Embedding-Lookup ist ungecached

Jede Suchanfrage geht fuer das Query-Embedding erneut an den Embedding-Endpunkt. Das ist ein externer Netz- und Modell-Roundtrip.

### F. Fehlende Stufenmessung

Es gibt heute keine saubere Aufteilung von Suchzeit in:

- embedding
- elasticsearch chunk candidates
- elasticsearch document candidates
- sql retrieval
- rerank
- refinement
- small-to-big
- file enrichment

Ohne diese Sicht ist Tuning unnoetig riskant.

## Tuning-Ziele

### Ziel-Latenzen

Interaktive Ziele fuer typische Queries:

- Ragfind einfache Suche: p50 < 400 ms, p95 < 900 ms ohne Embedding-Cache-Miss
- MCP `smart_search`: p50 < 700 ms, p95 < 1500 ms
- MCP `search_rag_context`: p50 < 500 ms, p95 < 1200 ms

Mit Cache-Miss beim Query-Embedding duerfen die Zahlen hoeher sein, sollten aber trotzdem kontrolliert bleiben.

### Zielarchitektur fuer Suchpfade

Fast Path:

- Embedding aus Cache oder schneller Modell-Call
- Elasticsearch oder schmaler PG-Vorfilter liefert kleine Kandidatenmenge
- PostgreSQL rerankt nur diese Kandidaten
- kein Small-to-big, kein Dokumentfokus, keine narrativen Zusatzstufen

Deep Path:

- fuer schwierige oder hochwertige Fragen
- Fokus-Refinement, Small-to-big, Dokumentfokus, weitere Kontextstufen
- explizit oder heuristisch zugeschaltet

## Phase 0: Messbarkeit herstellen

### 0.1 Stufen-Timing einbauen

Einbau in `src/routes/api.ts` und `src/ragfind/server.ts`:

- Zeit fuer `vectorService.embedOne(...)`
- Zeit fuer `searchChunkCandidates(...)`
- Zeit fuer `searchDocumentCandidates(...)`
- Zeit fuer die grosse SQL-Query in `executeSimilarityQuery(...)`
- Zeit fuer `refineItemsWithinDocument(...)`
- Zeit fuer `refineNarrativeSectionsWithinDocument(...)`
- Zeit fuer `applySmallToBigWithWindow(...)`
- Zeit fuer `attachOriginalFiles(...)`
- Zeit fuer Ragfind-Gruppierung plus Supplemental-Search

Ausgabe:

- API-Log je Query
- optional Debug-Response fuer Admin oder lokales Benchmarking

### 0.2 Baseline-Messungen festschreiben

Vor jeder inhaltlichen Optimierung messen:

- p50, p95, max
- Query-Typen: kurz, lang, typo-lastig, dokumentfokussiert, inventory-artig
- Ragfind und MCP getrennt
- mit und ohne Elasticsearch erreichbar

### 0.3 EXPLAIN ANALYZE fuer Schluesselqueries

Explizit messen fuer:

- Hauptquery aus `executeSimilarityQuery(...)`
- `findSupplementalDocuments(...)`
- `refineItemsWithinDocument(...)`
- `refineNarrativeSectionsWithinDocument(...)`

Ergebnis soll dokumentiert werden mit:

- Seq Scan vs Index Scan
- Rows before filter
- Sort- und Hash-Kosten
- Anteil von Trigram- und Textsearch-Teilen

## Phase 1: Hohe Hebel mit geringem Risiko

### 1.1 Elasticsearch-Kandidaten als harter Vorfilter

Prioritaet: sehr hoch

Heute:

- ES-Kandidaten werden geholt
- PostgreSQL arbeitet trotzdem noch zu breit

Ziel:

- `elasticChunkCandidateIds` und/oder `elasticDocumentCandidates` muessen die SQL-Menge begrenzen
- SQL soll dann nur noch auf diesen Chunk- oder Dokument-IDs laufen

Konkrete Umsetzung:

- in `executeSimilarityQuery(...)` eine CTE fuer `candidate_documents` oder `candidate_chunks`
- wenn ES Kandidaten liefert, nur auf diese IDs joinen
- Fallback auf bisherigen PG-Pfad nur dann, wenn ES nichts liefert oder deaktiviert ist

Erwarteter Effekt:

- deutlich weniger Arbeit in `document_signals`
- schnellere Keyword- und Vector-CTEs
- weniger Sortier- und Gruppierungskosten

### 1.2 Fast Path fuer Ragfind und MCP

Prioritaet: sehr hoch

Ein neuer Suchmodus fuer interaktive Nutzung sollte standardmaessig deaktivieren:

- `preferDocumentFocus`
- `preferAdjacentSections`
- `enableSmallToBig`
- narrative section refinement

Nur bei Bedarf oder explizitem Deep-Modus zuschalten.

Betroffene Stellen:

- `executeSmartSearchQuery(...)`
- `buildSearchResults(...)`
- MCP `smart_search`

### 1.3 Ragfind-Rohkandidatenmenge reduzieren

Prioritaet: hoch

Aktuell:

- `retrievalTopK = Math.min(Math.max(topK * 6, 36), 120)`

Vorschlag:

- konservativer Fast-Mode: `topK * 3`
- kleineres Minimum, z. B. `12` oder `18`
- tieferes Maximum, z. B. `48`

Nur bei schwachen Queries oder wenigen Treffern eine zweite erweiterte Runde starten.

### 1.4 Query-Embedding-Cache

Prioritaet: hoch

Fuer normalisierte Query-Strings:

- In-Memory-LRU fuer Single-Instance
- optional Redis fuer mehrere App-Instanzen

Cache-Key:

- normalisierte Query
- Modellname

Effekt:

- MCP- und Ragfind-Wiederholungsqueries werden deutlich billiger

### 1.5 `findSupplementalDocuments(...)` abspecken

Prioritaet: hoch

Heute wird dort breit auf `documents.extracted_text` mit `LIKE` gearbeitet.

Vorschlaege:

- zuerst nur Titel plus `source_ref`
- `extracted_text` nur als spaeteres Fallback
- langfristig auf Elasticsearch umstellen

## Phase 2: PostgreSQL- und pgvector-Tuning

### 2.1 Materialisierte Normalisierungsfelder einfuehren

Prioritaet: hoch

Neue persistierte Felder oder generierte Spalten fuer:

- normalisierte Dokumentreferenz (`title + source_ref`)
- normalisierte Textvorschau des Dokuments
- normalisierte Chunk-Inhalte, wenn sinnvoll

Damit entfaellt ein Teil der wiederholten `lower(regexp_replace(...))`-Arbeit pro Query.

### 2.2 TSVECTOR-Spalten materialisieren

Prioritaet: hoch

Heute wird `to_tsvector(...)` in mehreren Queryteilen inline gebaut.

Vorschlag:

- `documents.lookup_tsv`
- `document_chunks.content_tsv`

mit Trigger oder Update-Logik beim Ingest.

Dann koennen die bestehenden GIN-Indizes sauberer greifen.

### 2.3 `document_signals` nur auf Kandidatenset rechnen

Prioritaet: sehr hoch

Die teuren Dokumentsignale duerfen nicht mehr ueber die gesamte Dokumentbasis laufen.

Ziel:

- Candidate Set aus ES oder schmalem PG-Filter
- `document_signals` nur fuer diese Dokument-IDs

### 2.4 Fuzzy-Anteile gezielter einsetzen

Prioritaet: mittel bis hoch

`similarity(...)` und `word_similarity(...)` sind teuer.

Vorschlag:

- nur fuer kurze Queries oder Typo-Verdacht
- nur auf Titel und `source_ref`
- nicht breit ueber `normalized_text`
- nur fuer wenige Dokumentkandidaten

### 2.5 pgvector-Tuning messen

Prioritaet: mittel

Vorhanden:

- `ivfflat` mit `lists = 100`

Pruefen:

- ob der Index wirklich genutzt wird
- ob `lists = 100` zur Datenmenge passt
- ob `ivfflat.probes` queryseitig gesetzt werden sollte
- ob HNSW in eurer pgvector-Version verfuegbar und schneller ist

Empfohlene Arbeitsschritte:

- `EXPLAIN ANALYZE` auf der Chunk-Vektorsuche
- Vergleich `ivfflat` vs HNSW
- Messung verschiedener `lists`/`probes`-Werte

### 2.6 Batch-Queries fuer Small-to-big

Prioritaet: mittel

Heute werden Kontextfenster itemweise geholt.

Ziel:

- mehrere Chunk-Fenster in einer Batch-Query laden
- zugehoerige Section-Metadaten ebenfalls batchen

### 2.7 DB-seitige Limits und Schutzmassnahmen

Prioritaet: mittel

Einbau von:

- `statement_timeout` fuer teure Deep-Queries
- Monitoring fuer langsame Queries
- Trennung von Fast Path und Deep Path mit verschiedenen Querybudgets

## Phase 3: Elasticsearch-Tuning

### 3.1 ES vom Zusatzsignal zum echten Candidate Retriever machen

Prioritaet: sehr hoch

Das ist der wichtigste ES-Schritt.

Heute:

- ES liefert Zusatzsignale

Ziel:

- ES liefert die Kandidatenmenge fuer Chunk- und Dokument-IDs
- PG macht nur das finale Reranking und Kontextladen

### 3.2 Mappings fuer Suchqualitaet und Geschwindigkeit ueberarbeiten

Prioritaet: hoch

Empfehlungen:

- eigene Felder fuer `title`, `source_ref`, `content`
- `keyword`-Subfields fuer Exact-Match-Faelle
- `copy_to` fuer ein gemeinsames Suchfeld
- analyzers fuer deutsch/mehrsprachig, `asciifolding`, lowercase
- optional `edge_ngram` oder `search_as_you_type` fuer UI-nahe Eingaben

### 3.3 Nicht den kompletten Dokumentvolltext als Standard-Suchfeld verwenden

Prioritaet: hoch

In `searchDocumentCandidates(...)` wird `extracted_text` voll befragt.

Vorschlag:

- stattdessen reduziertes Dokument-Suchfeld
- etwa Titel, `source_ref`, Exzerpt, strukturierte Felder
- Volltext primär auf Chunk-Ebene lassen

### 3.4 ES-Query-Kosten senken

Prioritaet: mittel

Moegliche Optimierungen:

- `track_total_hits: false`
- `terminate_after` fuer Fast Path
- kleinere `size` fuer Kandidatensuche
- `_source` minimal halten, was bereits teilweise geschieht
- `msearch` statt zwei separater ES-Requests pruefen

### 3.5 Index-Betriebsparameter tunen

Prioritaet: mittel

Fuer die Laufzeit:

- `refresh_interval` erhoehen, wenn Near-Real-Time nicht kritisch ist
- in Single-Node-Setups `number_of_replicas = 0`
- Heap-Groesse und Circuit Breaker beobachten
- Shard-Zahl explizit passend setzen statt Defaults zu akzeptieren

### 3.6 ES-Aliasse oder Filter je Knowledge Base

Prioritaet: mittel

Wenn KBs wachsen:

- filtered aliases oder Routing nach KB
- Kandidatensuche pro KB billiger machen

## Phase 4: Ragfind-spezifische Optimierungen

### 4.1 Zweistufige UI-Suche

Fast Path fuer erste Treffer:

- kleine Kandidatenmenge
- keine Deep-Refinements
- schnelle Antwort mit `tookMs`

Optionaler Follow-up:

- Deep Search nachladen
- mehr Snippets oder mehr Kontext erst danach

### 4.2 Debounce und Anfragekoaleszenz im Frontend

Wenn Ragfind bei jeder Eingabe sofort sucht:

- 200 bis 300 ms debounce
- inflight-request cancellation
- gleiche Querys deduplizieren

### 4.3 Snippet-Erzeugung nicht auf zu grossen Kontexten

`highlightSnippet(...)` sollte moeglichst nicht schon auf stark expandierten Kontexten laufen.

Erst kurze Treffer, dann optional erweiterten Kontext laden.

## Phase 5: MCP-spezifische Optimierungen

### 5.1 MCP standardmaessig auf Fast Path setzen

Interaktive Tool-Consumer profitieren mehr von Geschwindigkeit als von maximaler Kontextanreicherung.

Fuer MCP standardmaessig:

- geringere Kandidatenmengen
- kein Small-to-big
- nur leichte Dokumentfokuslogik

### 5.2 Wiederholte Queries cachen

Viele MCP-Clients senden sehr aehnliche oder identische Follow-up-Queries.

Cachebar sind:

- Query-Embedding
- ES-Kandidatenlisten
- finaler QueryResponse fuer kurze TTLs

### 5.3 Optionaler Deep-Mode als separates Tool

Moegliche Trennung:

- `smart_search_fast`
- `smart_search_deep`

Dann bleibt der Standard schnell, und hochwertige tiefe Suchen sind explizit.

## Phase 6: Infrastruktur und Betriebsoptimierung

### 6.1 Embedding-Service entlasten

Pruefen:

- Antwortzeit des Embedding-Modells
- Warm-start-Verhalten
- Keep-alive / Connection Reuse
- moeglicherweise kleineres, schnelleres Embedding-Modell testen

### 6.2 API-Instanzen horizontal skalieren

Wenn Last steigt:

- mehrere `ingestor-app`-Instanzen
- Redis-basierter Query-Cache
- ggf. getrennte Worker fuer Ingest und Search-orientierte App-Instanzen

### 6.3 DB- und ES-Ressourcen sauber dimensionieren

Pruefen:

- Shared Buffers / Work Mem fuer PostgreSQL
- ES-Heap und CPU-Saettigung
- I/O fuer pgvector- und GIN-Last

## Empfohlene Umsetzungsreihenfolge

### Sprint 1

- Stufen-Timings einbauen
- Baseline messen
- Ragfind-Kandidatenmenge reduzieren
- Fast Path fuer Ragfind und MCP einfuehren
- Query-Embedding-Cache einfuehren

### Sprint 2

- Elasticsearch-Kandidaten als harten PG-Vorfilter nutzen
- `document_signals` nur noch auf Kandidatenset rechnen
- `findSupplementalDocuments(...)` abspecken oder auf ES umstellen

### Sprint 3

- materialisierte Normalisierungsfelder
- materialisierte TSVECTOR-Spalten
- Batch-Optimierung fuer Small-to-big und Zusatzqueries

### Sprint 4

- Elasticsearch-Mappings und Queryprofil ueberarbeiten
- `track_total_hits`, `msearch`, `copy_to`, analyzer-Tuning
- Dokumentindex auf reduzierte Suchfelder umbauen

### Sprint 5

- pgvector-Tuning mit `EXPLAIN ANALYZE`
- HNSW vs IVFFLAT evaluieren
- `lists`/`probes` justieren

## Konkrete Erfolgskriterien

Als abgeschlossen gilt die Tuning-Arbeit erst, wenn folgende Punkte messbar erreicht sind:

- deutliche Reduktion von p95 fuer Ragfind und MCP
- Timing-Logs zeigen, dass der SQL-Hauptteil nicht mehr dominiert
- PostgreSQL arbeitet im Normalfall auf kleiner Kandidatenmenge
- Deep-Refinements laufen nur noch bewusst oder heuristisch sparsam
- ES ist echter Candidate Retriever und nicht nur Zusatzsignal
- wiederholte Queries umgehen den Embedding-Roundtrip ueber Cache

## Risiko- und Nebenwirkungscheck

Bei allen Performance-Schritten mitpruefen:

- Recall-Verlust durch zu aggressive Kandidatenbegrenzung
- Qualitaetsverlust bei deaktiviertem Small-to-big
- Unterschiede zwischen Ragfind und MCP duerfen nicht verwirrend werden
- ES-Abhaengigkeit braucht sauberen Fallback, falls ES kurzzeitig nicht erreichbar ist

## Empfehlung fuer den ersten konkreten Umsetzungsschritt

Wenn nur ein einzelner Hebel zuerst umgesetzt wird, dann dieser:

- `executeSimilarityQuery(...)` so umbauen, dass Elasticsearch-Kandidaten die PostgreSQL-Menge hart begrenzen

Das ist der Punkt mit dem besten Verhaeltnis aus Risiko, technischem Aufwand und erwartetem Latenzgewinn.