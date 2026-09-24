# RAG und RAGfind

Dokumentzentrierte RAG-Plattform mit Ingestion, hybrider Suche, MCP-Integration, Admin-Werkzeugen und einer separaten lokalen Suchoberfläche namens `RAGfind`.

Der Stack ingestiert Uploads, synchronisierte Verzeichnisse, gecrawlte Websites und Git-Repositories, extrahiert und strukturiert deren Inhalte, speichert Embeddings und Metadaten in PostgreSQL, stellt dokumentzentrierte APIs und MCP-Tools bereit und bietet zwei sichtbare Oberflächen:

- die Admin- und Betriebskonsole auf Port `3311`
- die Endnutzer-Suchoberfläche `RAGfind` auf Port `3312`

## Was Das Projekt Macht

Dieses Repository ist für Teams gedacht, die mehr brauchen als reine Vektorsuche.

Es kombiniert:

- Ingestion für Uploads, lokale Verzeichnisse, Websites und Git-Repositories
- OCR-Fallback für gescannte oder schwer extrahierbare Dokumente
- hybride Suche über Vektor-, Keyword-, Fuzzy- und dokumentzentrierte Reranking-Signale
- persistierte Dokumentstruktur mit Sections und Chunk-zu-Section-Zuordnung
- Analyse-Workflows für Aufgaben, Entscheidungen, Fristen, Risiken, Anforderungen, Setup-Schritte, Config-Keys, API-Surfaces und Zusammenfassungen
- MCP-Zugriff über HTTP und stdio für Open WebUI und andere MCP-fähige Clients
- wissensdatenbankbewusste Admin-Steuerung und principalbasierte Zugriffsskopierung
- `RAGfind` als separate Suchoberfläche mit lokalem Multisource-Viewer für HTML, Markdown, Code und Plaintext

## Aktuelle Laufzeitoberflächen

### Admin / API / MCP

- URL: `http://localhost:3311`
- stellt Operator-UI, Ingestion-Formulare, Dokumentbrowser, Admin-Einstellungen, Dokument-APIs und den MCP-Endpunkt bereit
- Basic Auth ist für Admin-Oberfläche und Admin-APIs aktiv
- Standard-Login ist `admin` / `admin`, bis es im UI geändert wird

### RAGfind

- URL: `http://localhost:3312`
- separater Such-Container und eigene Frontend-Oberfläche
- der Such-Scope ist im Admin-UI auf Port `3311` konfigurierbar
- gesucht wird nur in den für `RAGfind` freigegebenen Wissensdatenbanken
- Suchergebnisse öffnen in einem lokalen Multisource-Viewer statt direkt auf externe Seiten zu springen

### MCP

- HTTP-Endpunkt: `http://localhost:3311/mcp`
- lokaler stdio-Einstieg: `npm run dev:mcp:stdio` oder `npm run start:mcp:stdio`

## Screenshots

### Admin-UI

![Admin-UI](./admin-ui.jpg)

### RAGfind

![RAGfind Suche](./ragfind1.jpg)

![RAGfind Viewer](./ragfind2.jpg)

## Kernfunktionen

### Ingestion

- manuelle Uploads
- Import-Verzeichnis-Sync über gemounteten Ordner, standardmäßig mit einem Unterverzeichnis je Wissensdatenbank (siehe [Verzeichnis-Sync je Wissensdatenbank](#verzeichnis-sync-je-wissensdatenbank))
- rekursives Website-Crawling mit Download-Unterstützung für Dateien
- Git-Repository-Sync mit optionalem Branch- und Subpfad-Scope
- Extraktion für PDF, DOCX, ODT, TXT, Markdown, HTML, JSON, YAML, SQL, JS, TS, Python, Shell-Skripte und andere Text-/Code-Formate
- OCR-Fallback mit Tesseract und Ghostscript, wenn direkte Extraktion nicht ausreicht
- SHA-256-Deduplizierung vor Chunk- und Vektorpersistenz
- typabhängiges Chunking: die Ollama-Klassifizierung läuft vor dem Chunking und bestimmt sowohl den gespeicherten Dokumenttyp als auch Chunk-Größe und -Overlap (pro Typ in den Dokumenttyp-Einstellungen überschreibbar, sonst globaler Default)
- Embedding läuft vollständig asynchron im Hintergrund: Chunks werden sofort als `pending` persistiert, sind direkt über Volltext-/Trigram-Suche auffindbar und werden von einem separaten Worker eingebettet, sobald Ollama erreichbar ist — die Ingestion-Transaktion hält dabei nie auf einen Ollama-Roundtrip

### Retrieval

- semantische Vektorsuche in PostgreSQL plus pgvector
- PostgreSQL-Fulltext-Suche
- Fuzzy-Matching über Trigram-Indexe
- Exact-Match-Booster für Titel, Source-Ref und Inhalt
- dokumentzentriertes Reranking und Dokumentfokus-Verfeinerung
- Small-to-Big-Kontexterweiterung um starke Treffer herum
- Inventarmodus für Anfragen wie "welche Dokumente gibt es"
- Suchverbesserungen für Repo- und Entity-lastige MCP- und Open-WebUI-Abfragen

### Dokumentzentrierter Zugriff

- Volltextabruf kompletter Dokumente
- persistierte Sections und Strukturnavigation
- Originaldatei-Metadaten und stabile Download-URLs
- Dokumentvergleich und Versionsvergleich
- Cross-Reference-Abfragen über mehrere Dokumente hinweg
- lokaler Viewer für gecrawlte Websites, Markdown, Code-Dateien und Plaintext

### Analyse

- Extraktion von Meeting-Aufgaben
- Entscheidungsextraktion
- Fristenextraktion
- Anforderungsextraktion
- Extraktion von Config-Keys
- Extraktion von Setup-Schritten
- Extraktion von API-Surfaces
- Extraktion operativer Hinweise
- Risikoextraktion
- Entitätenextraktion
- Dokument- und Section-Zusammenfassungen

### Admin- und Multi-KB-Steuerung

- Knowledge-Base-CRUD im Admin-UI
- MCP-Principal-Verwaltung mit KB-Scope
- Admin-User-Verwaltung und Passwortwechsel-Flow
- editierbare Dokumenttyp-Einstellungen für Heuristik, Klassifikation, Smart Search sowie pro Typ überschreibbare Chunk-Größe und Chunk-Overlap (leer = globaler Default)
- konfigurierbarer Knowledge-Base-Scope für `RAGfind`

## Architektur

Zentrale Laufzeitkomponenten:

- `ingestor-app`: Express-API, Admin-Dashboard, Dokument-APIs, MCP über HTTP
- `ingestor-worker`: BullMQ-Worker für Hintergrund-Ingestion und Sync-Jobs
- `ragfind`: separater Express-Runtime für die `RAGfind`-Suche und den lokalen Viewer
- `rag-db`: PostgreSQL mit pgvector
- `redis`: BullMQ-Backend
- `elasticsearch`: optionale Hybrid-Suchsignalquelle
- externer Ollama-Endpunkt: Embeddings, Zusammenfassungen und Dokumentklassifikation

Primärer Ingestion-Flow:

1. Text aus Uploads, Syncs, Crawls oder Git-Inhalten extrahieren
2. bei unzureichender Extraktion auf OCR zurückfallen
3. Inhalte normalisieren und per Ollama klassifizieren — das Klassifikationsergebnis bestimmt sowohl den gespeicherten Dokumenttyp als auch die für diesen Typ konfigurierten (oder globalen) Chunk-Größen-/Overlap-Parameter
4. Inhalte anhand dieser Parameter in Chunks zerlegen und zusammen mit Dokumenten, Sections, Originaldatei-Metadaten und Analyse-Artefakten in PostgreSQL persistieren — Chunks erhalten zunächst `embedding_status = 'pending'` und sind sofort über Volltext- und Trigram-Suche auffindbar
5. Embeddings werden danach asynchron von einem Hintergrund-Worker erzeugt: ein Health-Check wartet auf einen erreichbaren Ollama-Endpunkt, transiente Fehler (Verbindungsabbruch, Timeout, 5xx) werden mit Backoff unbegrenzt wiederholt, permanente Konfigurationsfehler (z. B. Dimension-Mismatch) markieren die betroffenen Chunks sofort als `failed`, statt die Queue zu blockieren
6. Retrieval über HTTP, Admin-UI, MCP und `RAGfind` bereitstellen — der Live-Fortschritt des Embedding-Backlogs ist im Admin-Dashboard sichtbar (siehe „Dashboard und Admin-UI")

## Repository-Struktur

```text
src/
  config/          Environment-Handling
  db/              Pool, Migrationen, Startup-Migrationslauf
  mcp/             MCP-HTTP- und stdio-Einstiege
  ragfind/         separater RAGfind-Server-Einstieg
  routes/          HTTP-Endpunkte und gemeinsame Retrieval-Logik
  services/        Ingestion, Retrieval, OCR, Analyse, Sync, Crawl, Auth
  utils/           Chunking, Dateien, Hashing, Logging
  workers/         BullMQ-Worker-Runtime
migrations/        PostgreSQL-Schema- und Index-Migrationen
public/            Admin-/Operator-Frontend
public/ragfind/    RAGfind-Frontend
import-dir/        gemountetes Import-Verzeichnis für Sync-basierte Ingestion
scripts/           Hilfsskripte für Deployment-Workflows
```

## Verzeichnis-Sync je Wissensdatenbank

Der Verzeichnis-Sync ordnet jedes direkte Unterverzeichnis von `IMPORT_DIR` genau einer
Wissensdatenbank zu, damit sich Dokumente verschiedener Wissensräume nicht vermischen.
Der Ordnername ist dabei der Slug der Wissensdatenbank:

```
import-dir/
  default/       -> Wissensdatenbank "default"
  vertraege/     -> Wissensdatenbank "vertraege"
  technik/       -> Wissensdatenbank "technik"
```

Ablauf eines Syncs ohne explizit gewählte Wissensdatenbank:

1. Für jede aktive Wissensdatenbank wird der passende Ordner angelegt, falls er fehlt.
2. Jedes Unterverzeichnis wird rekursiv eingelesen und der Wissensdatenbank mit diesem Slug zugeordnet.
3. Ein Unterverzeichnis ohne passende Wissensdatenbank wird automatisch als neue Wissensdatenbank angelegt
   (abschaltbar über `SYNC_AUTO_CREATE_KNOWLEDGE_BASES=false`; dann wird der Ordner übersprungen und im Ergebnis gemeldet).
4. Dateien, die direkt im Root-Verzeichnis liegen, landen in `default`.

Wird im Admin-UI oder per `POST /api/jobs/sync` eine konkrete `knowledgeBaseId` gesetzt, gilt weiterhin
das alte Verhalten: der komplette Baum unterhalb des Root-Verzeichnisses geht in genau diese Wissensdatenbank.
Mit `SYNC_KNOWLEDGE_BASE_SUBDIRS=false` lässt sich die Unterverzeichnis-Zuordnung global deaktivieren.

Die Deduplizierung greift pro Wissensdatenbank (`content_hash` + `knowledge_base_id`), dieselbe Datei kann
also bewusst in mehreren Wissensdatenbanken liegen. Das Job-Ergebnis in der Queue-Ansicht zeigt pro
Wissensdatenbank, wie viele Dateien gescannt, importiert und als Duplikat erkannt wurden.

## Crawl-Optionen

Beim Anlegen eines Crawls lässt sich getrennt steuern, was neben den Seiten selbst geholt wird:

- **Verlinkte Dokumente mitladen** (Standard: an) — PDF, DOCX, ODT, TXT und Markdown werden
  heruntergeladen und wie ein Upload eingelesen, inklusive Textextraktion und OCR.
- **Bilder mitladen (OCR)** (Standard: aus) — jedes gefundene Bild wird per OCR gelesen.

Die Trennung hat einen praktischen Grund: früher hingen beide am selben Schalter, weshalb ein Crawl
über eine bildlastige Seite jedes Logo und jede Kartenkachel durch Ghostscript und Tesseract
schickte. Das dauert um Größenordnungen länger als der restliche Crawl. Bilder lohnen sich, wenn es
gescannte Dokumente sind — sonst nicht.

Ein abgewählter Dateityp wird auch nicht als Seite abgerufen, nicht nur nicht ingestiert.

Ein Bild, in dem OCR keinen Text findet, ist kein Fehlerfall: es wird mit einer kurzen Beschreibung
aus Dateiname und Herkunft aufgenommen (`ocrEmpty: true` in den Metadaten), ist über seinen Namen
auffindbar und im RAGfind-Viewer als Bild zu sehen. Vorher warf die Ingestion dort
`no text extracted`, und weil der Crawl seine Adressen nicht einzeln absicherte, riss diese eine
Ausnahme den ganzen Lauf mit — bei einem Crawl in die Tiefe also den Großteil der Arbeit. Jede
Adresse läuft jetzt für sich: eine nicht erreichbare Seite, eine Zeitüberschreitung oder eine Datei
ohne lesbaren Inhalt wird protokolliert und gezählt, der Crawl macht weiter. Das Ergebnis enthält
neben `pages`, `files` und `duplicates` deshalb auch `failed`.

Über die API entsprechen die Schalter `downloadDocuments` und `downloadImages` in
`POST /api/jobs/crawl`; fehlen sie, gelten dieselben Standardwerte. Für geplante Crawls können sie
im Payload des Zeitplans stehen.

## Aktualisieren

`./update.sh` bringt eine laufende Installation auf den neuesten Stand, ohne Daten zu verlieren:

```bash
./update.sh                  # sichern, git pull, neu bauen, starten, pruefen
./update.sh --no-pull        # nur neu bauen und starten
./update.sh --skip-backup    # ohne Sicherung
```

Die Reihenfolge ist Absicht — erst sichern, dann ziehen. Vor jeder Aenderung landen ein
PostgreSQL-Dump, ein Archiv der Originaldateien aus dem `app-data`-Volume und die `.env` unter
`backups/<zeitstempel>/`, zusammen mit einer Wiederherstellungs-Anleitung. Schlaegt etwas fehl,
bricht das Skript ab, bevor es etwas veraendert hat.

`docker compose down -v` kommt bewusst nicht vor: das wuerde die Volumes und damit Datenbank und
Originaldateien loeschen. Elasticsearch wird nicht gesichert, weil sich der Index im Admin-UI
jederzeit aus PostgreSQL neu aufbauen laesst.

Nach dem Update meldet das Skript, welche Schluessel aus `.env.example` in der eigenen `.env`
fehlen, und erinnert an Reindex beziehungsweise Re-Embedding, falls eine Aenderung das noetig macht.

## Retrieval-Qualität messen

`npm run eval` misst Recall@k, MRR, nDCG@k und Precision@1 gegen ein Goldenset echter Fragen.
Der Lauf geht über denselben Suchpfad wie RAGfind und MCP (`executeSmartSearchQuery`), inklusive
Reranking und Small-to-Big.

```bash
cp eval/goldenset.example.json eval/goldenset.json   # oder:
npm run eval:bootstrap                               # Template aus dem eigenen Bestand
# Fragen in eval/goldenset.json eintragen
npm run eval -- --tag baseline
npm run eval -- --tag nachher --baseline eval/results/baseline.json
```

Der Vergleich gegen eine Baseline zeigt pro Frage, was besser und was schlechter wurde — Mittelwerte
allein verstecken Regressionen. Details und der geplante Ausbau stehen in `optimierungsplan.md`.

`eval/goldenset.json` und `eval/results/` sind bewusst nicht im Repository: sie enthalten Fragen
und Trefferlisten aus dem jeweils eigenen Dokumentbestand.

## Deutsche Volltextsuche

Neben den `simple`-tsvector-Spalten existieren deutsche Varianten (`*_tsv_de`, Migration 021) mit
Snowball-Stemming und deutschen Stoppwörtern, damit „Dienstpläne" auch „Dienstplan" findet. Beide
werden abgefragt, der bessere Rang gewinnt — `simple` bleibt zuständig für exakte Treffer auf
Dateinamen, Aktenzeichen und Bezeichner. Elasticsearch spiegelt das über ein `.de`-Unterfeld mit
dem Analyzer `german_rag`.

Die Elasticsearch-Indizes tragen deshalb ein Versionssuffix (`rag-documents-v2`, `rag-chunks-v2`).
Nach einem Deploy einmal *Reindex starten* im Admin-UI ausführen; die alten Indizes ohne Suffix
können anschließend gelöscht werden.

## Cross-Encoder-Reranking

Die besten Kandidaten einer Suche werden optional von einem Reranking-Modell nachsortiert, das
Frage und Passage gemeinsam bewertet. Konfiguriert wird das im Admin-UI unter *Config-AI*:
Basis-URL, Modellname und wie viele Kandidaten (`top_n`) an den Reranker gehen. Die Kosten wachsen
linear mit der Kandidatenzahl (gemessen mit Qwen3-Reranker-0.6B: 8 Kandidaten ~740 ms, 12 ~1090 ms,
20 ~1800 ms), der Default liegt deshalb bei 12.

Unterstützt wird jeder Server mit `POST /v1/rerank` (Fallback `/rerank`) im Cohere/Jina-Schema —
llama.cpp mit `--reranking`, TEI, Infinity und vLLM. Empfehlung für deutschen Bestand:
`bge-reranker-v2-m3` oder `Qwen3-Reranker-0.6B`.

Der Reranker sitzt im Live-Suchpfad und ist deshalb abgesichert: harter Timeout, begrenzte
Parallelität und 30 Sekunden Cooldown nach einem Fehler. Ist er aus, nicht erreichbar oder im
Cooldown, greift automatisch das bisherige heuristische Reranking — die Suche liefert immer
Ergebnisse, im Zweifel nur schlechter sortierte. `crossEncoderRerank` im Debug-Log und die
`rerankMs`-Stufenzeit zeigen pro Anfrage, welcher Weg genommen wurde.

## Dokumentansicht in RAGfind

Ein Suchtreffer öffnet das Dokument so, wie man es erwartet — nicht als Rohtext und nie als
erzwungener Download. Welche Darstellung das ist, entscheidet `src/ragfind/viewerModel.ts` anhand
von Dateityp, MIME-Typ und Herkunft:

| Dokument | Ansicht |
| --- | --- |
| PDF | eingebetteter Betrachter auf Basis von pdf.js, mit Seitennavigation, Zoom und Volltextsuche im Dokument |
| DOCX, ODT, PPTX, XLSX, RTF, CSV | von LibreOffice erzeugte PDF-Fassung, dann derselbe Betrachter |
| gecrawlte Seite | die gespeicherte HTML-Kopie, mit Stylesheets, Bildern und Schriften |
| Bild | das Bild selbst, der erkannte Text daneben |
| Audio, Video | Abspieler |
| Markdown | gerendert |
| Quelltext | mit Syntaxhervorhebung |
| sonstiges | extrahierter Text, notfalls eine Karte mit Dateiangaben und Download |

Die Tabs richten sich nach dem, was es zu einem Dokument gibt: **Ansicht**, **Text** (die
extrahierte Fassung mit hervorgehobenen Suchbegriffen und Sprung von Treffer zu Treffer),
**Abschnitte** beziehungsweise **Inhalt** (bei PDFs mit eigener Gliederung deren Lesezeichen) und
**Details**. Die Suchanfrage wird an die Ansicht weitergereicht: im PDF sucht der Betrachter sie
selbst und springt zur ersten Fundstelle, im Text sind die Begriffe markiert. Ein Klick auf einen
Textausschnitt in der Trefferliste springt an genau diese Stelle.

pdf.js wird nicht ins Repository kopiert, sondern zur Laufzeit aus `node_modules/pdfjs-dist` unter
`/pdfjs` ausgeliefert. PDF-Fassungen und Vorschaubilder liegen als abgeleitete Dateien neben dem
Original unter `.derived/`; sie entstehen beim ersten Abruf und werden ungültig, sobald das
Original neuer ist.

### Gespeicherte Webseiten

Die Kopie wird über `/view/<id>/page` in einem Rahmen geladen. Beim Ausliefern werden alle
Verweise auf Stylesheets, Bilder, Schriften und Medien auf `/view/<id>/asset?u=…` umgebogen; dieser
Endpunkt holt die Datei serverseitig und liefert sie unter der Herkunft von RAGfind aus.

Der Umweg ist notwendig, nicht bequem: viele Seiten senden auf ihren eigenen Dateien
`Cross-Origin-Resource-Policy: same-site`. Der Browser blockiert sie damit für jedes fremde
Dokument, ganz gleich wie großzügig dessen Content-Security-Policy ist — die Kopie erschien vorher
als nackter Text. Der Proxy fasst nur öffentliche Adressen an (private und lokale Bereiche werden
nach Namensauflösung abgewiesen), lässt nur Stylesheets, Bilder, Schriften und Medien durch und
schreibt in Stylesheets auch die dort enthaltenen Adressen um. Links auf andere Seiten werden
absolut gemacht und zeigen weiterhin auf das Original.

Skripte bleiben außen vor: sie werden beim Speichern entfernt, die Content-Security-Policy des
Endpunkts verbietet sie, und der Rahmen ist zusätzlich sandboxed.

Seiten, die vor der Einführung dieser Speicherung gecrawlt wurden, haben keine HTML-Kopie und
erscheinen als Text. Ein erneuter Crawl derselben Adresse trägt die Kopie nachträglich nach, auch
wenn der Text unverändert ist.

## Trefferliste in RAGfind

Die Liste zeigt je Dokument ein Vorschaubild (erste Seite bei PDF und Office, das Bild selbst bei
Bildern), Dokumenttyp, Wissensdatenbank, Dateigröße und Datum, die Zusammenfassung aus der
Klassifizierung und die Fundstellen im Text. Rechts stehen Filter für Dokumenttyp, Wissensdatenbank
und Dateityp sowie die Sortierung nach Relevanz oder Datum; beides wirkt sofort und steht in der
Adresse, ist also teilbar. Weitere Treffer kommen über einen Knopf dazu, statt die Liste auf zwölf
Einträge zu beschneiden.

Während der Suche steht ein Platzhalter statt einer leeren Seite — eine Anfrage kostet je nach
Ollama-Antwortzeit mehrere Sekunden. Ergebnisse werden serverseitig fünf Minuten und im Browser für
die Sitzung vorgehalten: Wer einen Treffer öffnet und zurückgeht, sieht die Liste sofort wieder.
Ohne Treffer schlägt die Suche über Trigram-Ähnlichkeit ein anderes Wort vor. `/` springt ins
Suchfeld, Pfeiltasten wählen einen Treffer, Enter öffnet ihn.

## Embedding-Input

Embeddet wird nicht der rohe Chunk, sondern ein Kontext-Header aus Dokumenttitel und
Abschnittsüberschrift plus der Chunk-Inhalt, versehen mit dem Task-Prefix des jeweiligen Modells
(`search_document:` / `search_query:` bei nomic, `passage:` / `query:` bei e5 — automatisch aus dem
Modellnamen abgeleitet, überschreibbar via `EMBEDDING_DOCUMENT_PREFIX` / `EMBEDDING_QUERY_PREFIX`).
Der Header steht ausschließlich im Embedding-Input, nie in `document_chunks.content`.

`document_chunks.embedding_input_version` hält fest, mit welcher Input-Form ein Vektor entstanden
ist. Ändert sich die Form ohne Modellwechsel, findet der normale Re-Embedding-Lauf nichts — dafür
gibt es *Re-Embedding starten* im Bereich Config-AI (entspricht `POST /admin/embeddings/reembed`
mit `{"force": true}`).

## Betrieb mit vLLM

vLLM spricht dieselbe OpenAI-kompatible API wie llama.cpp, LM Studio oder TGI. Im Admin-UI unter
*Config-AI* deshalb Provider **OpenAI-kompatibel** wählen, als Basis-URL den `/v1`-Pfad eintragen
(z. B. `http://host:8000/v1`) und das API-Key-Feld leer lassen — es ist optional und wird nur
gebraucht, wenn der Server mit `--api-key` gestartet wurde.

Die drei Rollen können auf getrennten vLLM-Instanzen laufen; Embedding und LLM teilen sich die
Provider-Konfiguration, der Reranker hat eine eigene Basis-URL.

```bash
# Embeddings
vllm serve nomic-ai/nomic-embed-text-v1.5 \
  --served-model-name nomic-embed-text --trust-remote-code \
  --port 8000 --max-model-len 2048

# Reranker (Cross-Encoder)
vllm serve BAAI/bge-reranker-v2-m3 \
  --served-model-name bge-reranker-v2-m3 --port 8001

# LLM für Klassifikation und Zusammenfassung
vllm serve Qwen/Qwen2.5-7B-Instruct --port 8002
```

Die Flags zur Modellrolle heißen je nach vLLM-Version unterschiedlich (`--task embed` / `--task
score` in älteren, `--runner pooling` in neueren Versionen). Statt sich darauf zu verlassen, lässt
sich ein Endpunkt direkt prüfen:

```bash
npm run check:provider -- \
  --base-url http://host:8000/v1 \
  --embedding-model nomic-embed-text \
  --llm-model Qwen/Qwen2.5-7B-Instruct \
  --reranker-url http://host:8001 \
  --reranker-model bge-reranker-v2-m3
```

Das Werkzeug fährt genau die Codepfade der Anwendung gegen den Endpunkt — Modell-Liste,
Einzel- und Batch-Embedding, Dimension, Task-Prefixes, maximale Eingabelänge, Textgenerierung,
JSON-Antwort für die Klassifikation und den Rerank-Endpunkt — und gibt am Ende die Werte aus, die
in *Config-AI* einzutragen sind. Es braucht keine Datenbank und ändert nichts auf dem Server.

Worauf zu achten ist:

- **Eingabelänge:** Bei vLLM begrenzt `--max-model-len` eine einzelne Eingabe. Der Checker misst
  das Limit und sagt, ob es für die Chunk-Größen dieser Anwendung reicht.
- **Embedding-Dimension:** Weicht sie vom Bestand ab, ist vor dem Umschalten
  `ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(n)` nötig, danach ein
  vollständiges Re-Embedding. Das Admin-UI prüft die Dimension beim Speichern und lehnt einen
  Konflikt ab.
- **Task-Prefixes** werden aus dem Modellnamen abgeleitet. vLLM meldet oft den vollen HF-Pfad
  (`nomic-ai/nomic-embed-text-v1.5`), was erkannt wird; bei exotischen Namen helfen
  `EMBEDDING_DOCUMENT_PREFIX` / `EMBEDDING_QUERY_PREFIX`.
- **Erste Inferenz schlägt fehl, Modell-Liste funktioniert:** Meldet der Server
  `Failed to find C compiler` oder verweist auf `triton.knobs.build.impl`, fehlt im
  vLLM-Container ein C-Compiler. vLLM kompiliert Triton-Kernel beim ersten echten
  Aufruf; `/v1/models` läuft deshalb, `/v1/embeddings` nicht. Abhilfe: `gcc` bzw.
  `build-essential` im vLLM-Image installieren oder `CC` auf einen vorhandenen
  Compiler setzen. Ein solcher Fehler wird jetzt als
  `AI provider at ... answered HTTP 500: ...` gemeldet — der Server war also
  erreichbar, die Ursache liegt bei ihm.
- **Strukturierte Antworten:** Lehnt ein Server `response_format: json_object` ab, wird die Anfrage
  automatisch ohne dieses Feld wiederholt. Die Klassifikation funktioniert dadurch auch auf
  Servern ohne Guided Decoding.

## Eingabelimits des Modellservers

Läuft das Embedding- oder Reranking-Modell auf llama.cpp, begrenzt dessen physische Batchgröße
(`ubatch`, Default 512 Token) die Länge einer einzelnen Eingabe. Eine längere Eingabe wird mit
HTTP 500 abgelehnt und würde ohne Gegenmaßnahme den ganzen Batch scheitern lassen. `CHUNK_SIZE`
schützt davor nicht: es zählt mit `gpt-tokenizer`, während deutsche Texte im Modell-Tokenizer etwa
doppelt so dicht kodieren — 300 „Chunk-Token" können 600 Modell-Token sein, OCR-Tabellen mit
zusammengelaufenen Wörtern noch mehr.

Der Stack geht damit zweistufig um:

1. `EMBEDDING_MAX_INPUT_CHARS` bzw. `RERANKER_DOCUMENT_MAX_CHARS` kappen die Eingabe vorab.
2. Lehnt der Server sie trotzdem ab, wird der Batch aufgeteilt, der auffällige Eintrag schrittweise
   gekürzt und erneut geschickt. Das ist unabhängig vom Tokenizer und funktioniert deshalb auch
   nach einem Modellwechsel.

Sauberer ist es, den Server mit größerem `ubatch` zu starten (`llama-server -ub 2048 -b 2048`).
Dann greifen die Kürzungen nie, und Reranking sowie Embedding sehen den vollständigen Text.

## Anforderungen

- Node.js `20.11+`
- PostgreSQL mit pgvector
- Redis
- externer Ollama-Endpunkt
- Docker und Docker Compose für den einfachsten lokalen Betrieb
- optionale OCR-Abhängigkeiten für gescannte Inhalte

## Schnellstart Mit Docker Compose

1. Environment-Vorlage kopieren.

```bash
cp .env.example .env
```

2. Mindestens diese Werte anpassen:

- `OLLAMA_BASE_URL` (Seed-Wert; die laufende KI-Provider-Konfiguration wird danach im Admin-UI unter „Config-AI" verwaltet)
- optional `PUBLIC_BASE_URL`

3. Gesamten Stack bauen und starten.

```bash
docker compose up --build
```

4. Admin-Konsole unter `http://localhost:3311` öffnen.

5. `RAGfind` unter `http://localhost:3312` öffnen.

Der Standard-Compose-Stack startet:

- Admin/API/MCP auf `3311`
- `RAGfind` auf `3312`
- PostgreSQL auf Host-Port `5433`
- Redis auf Host-Port `6379`
- Elasticsearch auf Host-Port `9200`

## Lokale Entwicklung

1. Abhängigkeiten installieren.

```bash
npm install
```

2. Environment-Datei kopieren und anpassen.

```bash
cp .env.example .env
```

3. PostgreSQL, Redis, optional Elasticsearch und den Ollama-Endpunkt starten.

4. Migrationen ausführen.

```bash
npm run migrate
```

5. API, Worker und optional `RAGfind` in getrennten Terminals starten.

```bash
npm run dev
```

```bash
npm run dev:worker
```

```bash
npm run dev:ragfind
```

## Verfügbare Skripte

```bash
npm run dev              # API im Watch-Modus starten
npm run dev:worker       # BullMQ-Worker im Watch-Modus starten
npm run dev:ragfind      # RAGfind-Server im Watch-Modus starten
npm run dev:mcp:stdio    # MCP-Server über stdio im Watch-Modus starten
npm run build            # TypeScript kompilieren
npm run start            # kompilierte API starten
npm run start:worker     # kompilierten Worker starten
npm run start:ragfind    # kompilierten RAGfind-Server starten
npm run start:mcp:stdio  # kompilierten MCP-stdio-Server starten
npm run migrate          # SQL-Migrationen ausführen
```

## Wichtige Environment-Variablen

Kernservices:

- `PORT`: Admin/API-Port, Standard `3311`
- `DATABASE_URL`: PostgreSQL-Connection-String
- `REDIS_URL`: Redis-Connection-String
- `PUBLIC_BASE_URL`: Basis für erzeugte Download-Links und externe Referenzen

LLM und Embeddings (nur Seed-Werte für die Erstinstallation - die dauerhafte Konfiguration erfolgt danach im Admin-UI unter „Config-AI", siehe unten):

- `OLLAMA_BASE_URL`
- `EMBEDDING_MODEL`
- `LLM_MODEL`
- `DOCUMENT_CLASSIFIER_MODEL`
- `EMBEDDING_DIMENSION`

Speicherung und Ingestion:

- `IMPORT_DIR`
- `UPLOAD_DIR`
- `ORIGINAL_STORAGE_DIR`
- `GIT_REPO_CACHE_DIR`
- `GIT_REPO_MAX_FILE_BYTES`
- `CRAWL_DEFAULT_MAX_DEPTH`

Retrieval-Tuning:

- `QUERY_TOP_K`
- `QUERY_CANDIDATE_K`
- `QUERY_MAX_CHUNKS_PER_DOCUMENT`
- `QUERY_VECTOR_WEIGHT`
- `QUERY_KEYWORD_WEIGHT`
- `QUERY_EXACT_MATCH_BOOST`
- `QUERY_RERANK_TOP_N`
- `QUERY_SMALL_TO_BIG_WINDOW`

Suchschicht-Integration:

- `ELASTICSEARCH_URL`
- `ELASTICSEARCH_INDEX_PREFIX`

Die aktuellen Defaults stehen in `.env.example`.

## Dashboard und Admin-UI

Die Admin-Konsole auf Port `3311` ist über ein Navigationsmenü mit sieben Bereichen strukturiert (Hash-Routing, also direkt verlinkbar und mit Vor-/Zurück-Navigation des Browsers nutzbar):

- **Übersicht** — Stats, System-Health (Ollama/Elasticsearch/Postgres) und Live-Fortschritt der asynchronen Embedding-Pipeline (Fortschrittsbalken „X / Y Chunks eingebettet" inkl. Hinweis auf fehlgeschlagene Chunks, sobald `failed > 0`)
- **Ingestion** — Upload-, Crawl-, Directory-Sync-, Schedule- und Git-Import-Formulare, Queue-Jobs und Embedding-Fortschritt
- **Dokumente** — Dokumentbrowser mit Vorschau, Filterung, Analyse-Werkbank und Unterstützung für Dokument-Reklassifikation
- **Suche** — RAG-Query-Test gegen den Such-Stack
- **Wissensbasis & Typen** — Knowledge-Base-Verwaltung, Dokumenttyp-Einstellungen (inkl. typabhängiger Chunk-Größe/-Overlap) und `RAGfind`-KB-Auswahl
- **System** — MCP-Principal-Verwaltung, Admin-User-Verwaltung, Passwortänderung, Elasticsearch-Operationen, Git-Repository-Import-Status und Laufzeitkonfiguration
- **Config-AI** — Konfiguration des KI-Providers (Ollama oder eine OpenAI-kompatible API): Server-URL, optionaler API-Key sowie je ein per Dropdown aus den auf dem Server tatsächlich verfügbaren Modellen wählbares Modell für Embedding, Zusammenfassung und Dokumentklassifizierung. Änderungen wirken sofort, ohne Neustart — ein Wechsel des Embedding-Modells wird beim Speichern per Testaufruf auf Dimensionskompatibilität geprüft und bei Konflikt mit einer verständlichen Fehlermeldung abgelehnt (siehe `EMBEDDING_DIMENSION` oben)

Die Admin-Konsole ist die Stelle, an der der Such-Scope für `RAGfind` konfiguriert wird.

Der Embedding-Fortschritt wird per Live-Polling (`GET /api/admin/embeddings/pending-status`) aktualisiert: solange Chunks noch `pending` oder `failed` sind, fragt die Oberfläche den Status alle 5 Sekunden ab und blendet die Anzeige aus, sobald alles eingebettet ist.

## RAGfind

`RAGfind` ist ein separater Container und ein separates Frontend für die Endnutzer-Dokumentsuche.

Aktuelles Verhalten:

- sucht nur in den für `RAGfind` aktivierten Wissensdatenbanken
- gruppiert Chunk-Treffer zu dokumentzentrierten Ergebnissen
- zieht bei Bedarf direkte Titel- und Source-Ref-Treffer als Ergänzung nach
- öffnet immer einen lokalen Viewer statt gecrawlte Seiten direkt auf der Live-Website aufzurufen
- bietet einen Multisource-Viewer mit gerendertem HTML, gerendertem Markdown, syntaxhervorgehobenem Code und einem Plaintext-Tab

## Open-WebUI-Integration

Open WebUI sollte nur über MCP angebunden werden.

Empfohlener Endpunkt:

```text
http://localhost:3311/mcp
```

Es gibt in diesem Repository keine mitverwalteten Open-WebUI-Python-Filter-, Tool- oder Action-Dateien mehr.

## MCP-Unterstützung

Der Service stellt MCP in zwei Modi bereit.

### Streamable HTTP MCP

Endpunkt:

```text
http://localhost:3311/mcp
```

### Lokales stdio-MCP

Entwicklung:

```bash
npm run dev:mcp:stdio
```

Produktions-Build:

```bash
npm run build
npm run start:mcp:stdio
```

### MCP-Tool-Kategorien

Verfügbare Tools decken ab:

- Retrieval und Smart Search
- Dokumentlisten und Dokument-Lookups
- Volltext-, Section- und Strukturzugriff
- Originaldatei-Metadaten
- Dokumentanalysen und Zusammenfassungen
- Dokumentvergleiche und Cross-Reference-Workflows

## Wichtige HTTP-API-Endpunkte

### Retrieval

- `POST /api/smart-search`
- `POST /api/cross-reference`

### Dokumente

- `GET /api/documents`
- `GET /api/documents/:id`
- `GET /api/documents/:id/fulltext`
- `GET /api/documents/:id/sections`
- `GET /api/documents/:id/structure`
- `GET /api/documents/:id/section`
- `GET /api/documents/:id/original/meta`
- `GET /api/documents/:id/original`

### Analyse

- `GET /api/documents/:id/analysis/actions`
- `GET /api/documents/:id/analysis/decisions`
- `GET /api/documents/:id/analysis/deadlines`
- `GET /api/documents/:id/analysis/requirements`
- `GET /api/documents/:id/analysis/config-keys`
- `GET /api/documents/:id/analysis/setup-steps`
- `GET /api/documents/:id/analysis/api-surface`
- `GET /api/documents/:id/analysis/operational-notes`
- `GET /api/documents/:id/analysis/risks`
- `GET /api/documents/:id/analysis/entities`
- `GET /api/documents/:id/summary`
- `GET /api/documents/:id/section-summary`
- `GET /api/documents/:id/compare`
- `GET /api/documents/:id/compare-version`

## Hinweise Zu Crawl und Git

- Website-Crawling folgt same-site Links und herunterladbaren Dateien
- weitergeleitete Domains wie `bmetallica.de -> www.bmetallica.de` werden über den Redirect-Ursprung hinweg korrekt gecrawlt
- Git-Ingestion unterstützt optionalen Branch- und Subpfad-Scope und indexiert gängige Text- und Code-Formate

## GitHub-Repository-Vorbereitung

Dieses Repository ist für die Veröffentlichung auf GitHub vorbereitet mit:

- einer repositorytauglichen README
- einer MIT-Lizenz
- `.gitignore` für Node, Build, lokale Envs und Import-Artefakte
- Anleitungen für containerbasierten und lokalen Betrieb
- einer klaren Trennung zwischen Admin-Oberfläche und `RAGfind`

## Lizenz

Dieses Projekt steht unter der MIT-Lizenz. Siehe `LICENSE`.

## Roadmap und Design-Notizen

Für tiefere Produkt- und Retrieval-Notizen siehe:

- `ROADMAP.md`
- `rag-logik.md`

## Status

Das Repository ist weiterhin in aktiver Entwicklung, die aktuelle Implementierung enthält aber bereits:

- Multi-Source-Ingestion
- typabhängiges Chunking auf Basis der vorgezogenen Ollama-Klassifizierung
- vollständig asynchrone Embedding-Pipeline mit Health-Check, fehlerklassifiziertem Retry und Live-Fortschrittsanzeige im Dashboard
- persistierte Struktur- und Originaldatei-Referenzen
- Analyse- und Summary-Workflows
- MCP-Integration
- wissensdatenbankbewusste Admin-Konfiguration
- Navigationsbasierte Admin-Oberfläche mit sieben klar getrennten Bereichen
- separate `RAGfind`-Sucherfahrung mit lokalem Viewer
