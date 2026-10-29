# Zweiter MCP-Server für opencode

> **Stand: umgesetzt.** Die Schritte 1–6 sind gebaut und geprüft; dieses Dokument beschreibt den
> Entwurf und bleibt als Begründung der Entscheidungen stehen. Die Bedienung steht im README unter
> „opencode-MCP".

## Ziel

Ein eigener MCP-Endpunkt, zugeschnitten auf einen Coding-Agenten (opencode), mit zwei Aufgaben:

- **A — Nachschlagen:** Zugriff auf eine Wissensdatenbank aus Quelltext, Handbüchern und
  Spezialwissen.
- **B — Dazulernen:** Der Agent legt selbst Wissen an, das beim nächsten Mal auffindbar ist.
  Vektorisierung läuft dabei über dieselbe Pipeline wie bei jedem anderen Dokument.

Wissensdatenbanken und Zugänge werden weiterhin ganz normal im Admin-UI angelegt. Neu ist
ausschließlich der zugeschnittene MCP-Server.

## Entschieden

| Frage | Entscheidung |
| --- | --- |
| Ziel der Schreibvorgänge | **Dieselbe Wissensdatenbank wie der Code** |
| Sichtbarkeit | **Sofort live**, keine Freigabe davor |
| Erreichbarkeit | **`/mcp/opencode`** in der bestehenden App (Port 3311) |
| Arbeitsmodell und Budgets | **im Admin-UI konfigurierbar**, nicht im Code |
| Inhalt der KB | Git-Sync vorhandener Repos **+** Dokumente/Handbücher **+** Dateien, die opencode selbst ablegt |

Geheimnisse im geschriebenen Text werden **markiert, nicht abgelehnt**.

Zusätzlich gesetzt (Standardentscheidungen, jederzeit umstellbar):

- Schreiben braucht ein **eigenes Recht am Principal** (`can_write`), nicht nur einen gültigen Token.
- Notizen haben einen **stabilen Schlüssel** und werden überschrieben, nicht angehäuft.
- Beim Schreiben wird die **LLM-Klassifizierung übersprungen**; der Dokumenttyp kommt vom Tool.

## Warum ein zweiter Server statt mehr Tools am bestehenden

Der vorhandene Server (`src/mcp/server.ts`) registriert **25 Tools** — Fristen, Meeting-Aufgaben,
Entscheidungen, Dokumentvergleich, Versionsvergleich, Cross-Reference. Für einen Coding-Agenten sind
davon höchstens fünf relevant, der Rest belegt Kontext und verschlechtert die Tool-Auswahl. Bei
einem kleinen, schnellen Modell ist das der entscheidende Punkt: **7 scharf beschriebene Tools
treffen besser als 25 breite.**

Der zweite Server teilt sich Authentifizierung, Scope-Logik und Retrieval-Pipeline mit dem ersten.
Dupliziert wird nur die Tool-Oberfläche.

## Was bereits steht und nicht neu gebaut wird

- **Authentifizierung und Scope:** `mcp_principals` mit Token, `principal_knowledge_bases` mit
  KB-Zuordnung je Principal. `/mcp*` läuft an der Admin-Basic-Auth vorbei und prüft stattdessen den
  Token (`src/index.ts:139`).
- **Code in die KB bekommen:** Git-Sync existiert inklusive Branch, Subpfad und Ziel-KB. Dokumente
  und Handbücher laufen über Upload, Import-Verzeichnis oder Crawl.
- **Dokumenttyp `source_code`** mit eigenem Such- und Chunking-Profil
  (`documentTypeRegistryService.ts:361`).
- **Asynchrones Embedding:** Chunks werden sofort als `pending` persistiert und sind direkt über
  Volltext und Trigram findbar; ein Worker bettet sie ein, sobald der Provider erreichbar ist. Ein
  Schreibvorgang muss also nie auf das Embedding warten.

## Der Tool-Satz

Sieben Tools, bewusst knapp beschrieben. Jedes Ergebnis ist in der Länge gedeckelt und markiert
Kürzungen sichtbar.

### Lesen

| Tool | Zweck |
| --- | --- |
| `search_knowledge(query, topK?, kind?, pathPrefix?)` | Hybride Suche über die zugeordnete KB. `kind` filtert auf `code`, `doc` oder `note`; `pathPrefix` auf Pfadanfang. Antwort: Titel, Pfad, Score, kurzer Auszug. |
| `get_file(path, startLine?, endLine?)` | Ganze Datei oder Zeilenbereich. Ohne Bereich mit Längenbegrenzung und Hinweis, wie weiterzublättern ist. |
| `list_sources(pathPrefix?, kind?, limit?)` | Inventar zum Navigieren: welche Dateien und Dokumente existieren überhaupt. |
| `get_note(noteKey)` | Eine bestimmte Notiz im Wortlaut — Voraussetzung dafür, dass der Agent sie gezielt fortschreiben kann. |

### Schreiben

| Tool | Zweck |
| --- | --- |
| `save_note(noteKey, title, text, tags?)` | Legt eine Notiz an oder **ersetzt** die vorhandene mit demselben Schlüssel. |
| `save_file(path, content, language?)` | Legt eine Quelltextdatei ab oder ersetzt sie. Für Projekte, die nicht in Git liegen. |
| `forget(noteKey)` | Löscht eine selbst angelegte Notiz. Ohne das kann der Agent Falsches nicht zurücknehmen. |

`forget` fasst ausschließlich Dokumente mit `source_type` aus dem opencode-Bereich an. Gecrawlte
Seiten, Uploads und Git-Dateien sind über dieses Tool nicht löschbar.

## Der Schreibpfad im Detail

### Klassifizierung überspringen

`ingestText` ruft heute vor dem Chunking das LLM zur Dokumenttyp-Bestimmung. Bei deinem Provider
sind das derzeit **bis zu 90 Sekunden pro Aufruf** — im Log dieser Installation mehrfach als Timeout
belegt. Ein Schreib-Tool, das so lange blockiert, benutzt kein Agent zweimal.

`IngestTextInput` bekommt deshalb zwei optionale Felder:

```ts
documentType?: string;      // explizit gesetzt, z. B. "note" oder "source_code"
skipClassification?: boolean;
```

Ist `skipClassification` gesetzt, entfällt der LLM-Roundtrip; Chunk-Größe und Overlap kommen aus den
Einstellungen des angegebenen Dokumenttyps. Für alle bestehenden Pfade ändert sich nichts.

### Überschreiben statt anhäufen

Ohne stabilen Schlüssel legt `ingestText` bei jeder Überarbeitung ein **neues** Dokument an, das alte
bleibt liegen. Ein Agent, der „was ich über X weiß" dreimal fortschreibt, hinterlässt drei einander
widersprechende Dokumente. Deshalb:

- `source_ref` ist der Schlüssel: `opencode://note/<noteKey>` beziehungsweise `opencode://file/<path>`.
- Vor dem Schreiben wird ein vorhandenes Dokument mit demselben `source_ref` in derselben KB
  gelöscht (Chunks, Sections, Artefakte, Originaldatei — dieselbe Logik wie `DELETE /api/documents/:id`).
- Danach wird frisch eingelesen. Damit bleiben Dokument-Id und Chunks konsistent zum Textstand.

### Die Falle mit dem globalen `content_hash`

`documents.content_hash` ist **systemweit** eindeutig. Schreibt der Agent einen Text, der wörtlich
schon als anderes Dokument existiert, bekommt er dieses zurück statt eines neuen. Gegenmittel: der
gespeicherte Text bekommt einen Kopf aus Schlüssel, Titel und Zeitpunkt — damit ist er faktisch
eindeutig, und der Kopf hilft zugleich beim Wiederfinden.

### Herkunft

Jedes geschriebene Dokument trägt in den Metadaten:

```json
{
  "author": "opencode",
  "noteKey": "…",
  "writtenAt": "…",
  "principal": "<Name des MCP-Principals>",
  "supersededDocumentId": 123
}
```

Weil Gelerntes in derselben KB liegt wie der Code, ist das die einzige Trennlinie — über
`source_type` und diese Metadaten lässt sich jederzeit filtern, auflisten und im Zweifel alles
Selbstgeschriebene auf einmal entfernen.

## Datenmodell und Rechte

Eine Migration:

```sql
ALTER TABLE mcp_principals
ADD COLUMN IF NOT EXISTS can_write BOOLEAN NOT NULL DEFAULT FALSE;
```

Standard ist `false` — bestehende Tokens (Open WebUI und andere) bekommen durch diese Änderung
**kein** Schreibrecht. Im Admin-UI kommt ein Schalter neben die Principal-Verwaltung,
`AuthenticatedMcpPrincipal` bekommt das Feld, und die drei Schreib-Tools weisen ohne das Recht mit
einer klaren Meldung ab.

## Routing und Authentifizierung

- Neuer Router `createOpencodeMcpRouter()` in `src/mcp/opencodeServer.ts`, in `src/index.ts`
  **vor** `/mcp` gemountet.
- Tokenprüfung wie gehabt über `resolveMcpPrincipalByToken`; der Endpunkt verlangt **immer** einen
  Token, auch wenn noch keine Principals angelegt sind (der bestehende Server lässt in diesem Fall
  alles durch — für einen schreibenden Endpunkt wäre das falsch).
- KB-Scope kommt aus dem Principal. Hat er mehrere KBs, wird gelesen aus allen; geschrieben wird in
  die Ziel-KB aus den Einstellungen (siehe unten).

## Einstellungen im Admin-UI

Das Arbeitsmodell von opencode steht nicht im Code. Dieselbe Installation soll in einer anderen
Landschaft mit einem anderen Modell laufen, ohne dass jemand Konstanten anfasst — also eine eigene
Einstellungsseite, analog zu den RAGfind-Einstellungen:

| Einstellung | Bedeutung |
| --- | --- |
| **Arbeitsmodell** | Freitext, z. B. `qwen3-coder-flash`. Dient der Nachvollziehbarkeit und steht im Log, wenn Antworten gekürzt werden. |
| **Kontextfenster (Tokens)** | Grundlage für die Vorbelegung der Budgets. |
| **Antwortbudget je Tool-Ergebnis (Zeichen)** | Vorbelegt aus dem Kontextfenster, frei überschreibbar. |
| **Harter Deckel (Zeichen)** | Obergrenze, die auch ein ausdrücklich angefordertes `get_file` nicht überschreitet. |
| **Standard- und Maximalwert für `topK`** | Wie viele Treffer eine Suche höchstens zurückgibt. |
| **Ziel-Wissensdatenbank fürs Schreiben** | Bei genau einer zugeordneten KB entfällt die Frage; bei mehreren braucht es eine ausdrückliche Wahl statt einer Vermutung. |

Gespeichert wird in `opencode_mcp_settings`. Ein Datensatz mit leerem `principal_id` enthält die
Standardwerte; zusätzliche Datensätze überschreiben sie **je Zugang**. Damit kann eine Installation
mehrere opencode-Landschaften mit unterschiedlichen Modellen bedienen, ohne dass sich die
Einstellungen gegenseitig stören.

## Chunking für Quelltext

Der Dokumenttyp `source_code` bringt eigene Chunk-Einstellungen mit; die Datei-Ablage nutzt sie.
Zusätzlich sinnvoll, aber nicht zwingend für die erste Fassung: Schnitt an Leerzeilen und
Symbolgrenzen statt an reiner Zeichenzahl, damit eine Funktion nicht mitten im Rumpf zerfällt. Der
Embedding-Input setzt ohnehin bereits einen Kopf aus Dokumenttitel und Abschnittsüberschrift davor.

## Risiken und was dagegen steht

| Risiko | Gegenmaßnahme |
| --- | --- |
| **Rückkopplung** — der Agent schreibt zurück, was er gerade gelesen hat, und verstärkt eigene Fehler | Herkunft in den Metadaten, `kind`-Filter beim Suchen, `forget`, und bei Bedarf ein Filter, der eigene Notizen in der Suche niedriger gewichtet |
| **Geheimnisse** — der Agent sieht Zugangsdaten im Code und schreibt sie dauerhaft in die KB | Mustererkennung beim Schreiben (Token-, Key-, Passwortformen): **markieren, nicht ablehnen** — `containsSecrets: true` plus Trefferart in den Metadaten, eine Warnzeile in der Tool-Antwort und ein Protokolleintrag. Der Inhalt wird gespeichert, bleibt aber im Admin-UI auffindbar und gezielt löschbar |
| **Vermischung** — Gelerntes und kuratierte Quellen in einer KB | `source_type`-Trennung plus Metadaten; Auflisten und Massenlöschen bleibt möglich |
| **Wildwuchs** — hunderte Kleinstnotizen | Stabiler Schlüssel erzwingt Überschreiben; `list_sources`/`get_note` erlauben dem Agenten, vorhandenes Wissen fortzuschreiben statt neues anzulegen |

## Updatefähigkeit

Die Änderungen müssen in eine **laufende Installation** einspielbar sein — `git pull` und
`./update.sh`, ohne Handarbeit an der Datenbank und ohne dass vorher etwas abgeschaltet wird. Daraus
folgen vier Regeln, die für jeden Schritt dieses Plans gelten:

- **Migrationen laufen bei jedem Start und müssen wiederholbar sein.** `runStartupMigrations` spielt
  sämtliche `.sql`-Dateien bei jedem Hochfahren erneut ein. `024_opencode_mcp.sql` benutzt deshalb
  durchgehend `IF NOT EXISTS` und einen `WHERE NOT EXISTS`-Wächter für den Standarddatensatz — ein
  zweiter Lauf ändert nichts.
- **Standardwerte erhalten das bisherige Verhalten.** `can_write` ist `FALSE`: bestehende Tokens
  bekommen durch das Update kein Schreibrecht. Der bestehende `/mcp`-Endpunkt bleibt unverändert,
  Open WebUI merkt vom Update nichts.
- **Keine Pflichtfelder in bestehenden Signaturen.** `documentType` und `skipClassification` kommen
  als optionale Felder in `IngestTextInput`; alle vorhandenen Aufrufer laufen unverändert weiter.
- **Neue Abhängigkeiten kommen über den Build.** Was in `package.json` steht, installiert der
  Docker-Build über `npm ci`; `update.sh` baut die Images ohnehin neu.

Abgenommen wird dieser Punkt nicht durch Argumentation, sondern durch einen echten Lauf von
`./update.sh` auf der bestehenden Installation: Migration greift, Dienste kommen hoch, vorhandene
Dokumente und Zugänge unverändert, danach sind die neuen Tools erreichbar.

## Umsetzung in Schritten

1. **Ingestion erweitern** — `documentType` und `skipClassification` in `IngestTextInput`,
   Upsert-Hilfsfunktion über `source_ref`, Löschlogik aus der API in einen wiederverwendbaren
   Service ziehen.
2. **Migration und Rechte** — `can_write`, `AuthenticatedMcpPrincipal`, Admin-UI-Schalter.
3. **Server mit Lese-Tools** — `search_knowledge`, `get_file`, `list_sources`, `get_note`,
   gedeckelte Ausgaben.
4. **Schreib-Tools** — `save_note`, `save_file`, `forget`.
5. **Admin-Sicht** — Liste „von opencode angelegt" mit Massenlöschung.
6. **Dokumentation** — README (deutsch und englisch) plus ein fertiges Konfigurationsbeispiel für
   opencode.
7. **Updatelauf** — `./update.sh` auf der laufenden Installation, Prüfung von Migration, Bestand und
   Erreichbarkeit.

Nach Schritt 3 ist A nutzbar, nach Schritt 4 auch B. Die Schritte 1–4 gehören in einen Commit-Strang;
5 und 6 können danach folgen.

## Bewusst nicht enthalten

- Kein Review-Workflow — so entschieden, Notizen sind sofort live.
- Keine eigene Container-Instanz — der Server läuft in der bestehenden App.
- Keine Änderung am bestehenden `/mcp`: Open WebUI und alles andere bleiben unberührt.
- Keine automatische Vektor-Neuberechnung bestehender Dokumente.

## Offene Punkte

- **Kontextfenster des Modells:** im UI einstellbar, Standardwerte 4 000 Zeichen je Antwort und
  12 000 als harter Deckel. Es bleibt bei sieben Tools — die Zahl über eine Einstellung zu steuern
  wäre erst sinnvoll, wenn sich zeigt, dass ein Modell damit überfordert ist.
- **`save_file` mit Patches:** vorerst nur vollständiger Dateiinhalt. Differenzen anzuwenden wäre
  ein eigener Schritt.
