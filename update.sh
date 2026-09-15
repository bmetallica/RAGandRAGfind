#!/usr/bin/env bash
#
# Aktualisiert eine laufende Installation ohne Datenverlust.
#
# Reihenfolge ist Absicht: erst sichern, dann ziehen, dann bauen, dann starten.
# Bricht ein Schritt ab, ist die Sicherung schon geschrieben und der alte Stand
# laeuft entweder noch oder laesst sich daraus wiederherstellen.
#
# Nicht verwendet wird "docker compose down -v" - das loescht die Volumes und
# damit Datenbank und Originaldateien.
#
#   ./update.sh                  Sicherung, git pull, Neubau, Start, Pruefung
#   ./update.sh --skip-backup    ohne Sicherung (nur wenn anderweitig gesichert)
#   ./update.sh --no-pull        nur neu bauen und starten, ohne git pull
#   ./update.sh --stash          lokale Aenderungen beiseitelegen und danach behalten
#   ./update.sh --help

set -euo pipefail

cd "$(dirname "$0")"

SKIP_BACKUP=0
DO_PULL=1
STASH=0
STASH_GESETZT=0
STAMP_VORAB="$(date +%Y%m%d-%H%M%S)"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-backup) SKIP_BACKUP=1 ;;
    --no-pull) DO_PULL=0 ;;
    --stash) STASH=1 ;;
    --help|-h)
      sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unbekannte Option: $1 (siehe --help)" >&2
      exit 2
      ;;
  esac
  shift
done

info()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()    { printf '    \033[32mOK\033[0m   %s\n' "$*"; }
warn()  { printf '    \033[33mHinweis\033[0m %s\n' "$*"; }
fail()  { printf '    \033[31mFEHLER\033[0m %s\n' "$*" >&2; }

# Bricht irgendein Schritt ab, soll niemand raten muessen, in welchem Zustand
# die Installation ist. Ohne diese Meldung endete ein Fehlschlag mit einem
# nackten Build-Log und der Frage, ob die Daten noch da sind.
BACKUP_DIR=""
abschluss() {
  code=$?
  [ "$code" = "0" ] && exit 0
  printf '\n\033[31m==> Abgebrochen\033[0m\n' >&2
  # Wurde vorher gestasht, darf der Abbruch den Arbeitsbaum nicht veraendert
  # zuruecklassen - sonst sind die eigenen Aenderungen scheinbar verschwunden.
  if [ "${STASH_GESETZT:-0}" = "1" ]; then
    if git stash pop >/dev/null 2>&1; then
      echo "    Beiseitegelegte Aenderungen wurden zurueckgeholt." >&2
    else
      echo "    ACHTUNG: beiseitegelegte Aenderungen liegen noch im Stash." >&2
      echo "    Zurueckholen mit: git stash pop" >&2
    fi
  fi
  echo "    Die laufende Installation wurde nicht veraendert: es gab kein 'down'," >&2
  echo "    keine Volume-Aenderung und keine Migration ausserhalb des Starts." >&2
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    echo "    Sicherung liegt unter: $BACKUP_DIR" >&2
  fi
  echo "    Laufen die Container noch? 'docker compose ps'" >&2
  exit "$code"
}
trap abschluss EXIT

# --- Voraussetzungen ---------------------------------------------------------
info "Voraussetzungen"

for tool in git docker; do
  command -v "$tool" >/dev/null 2>&1 || { fail "$tool nicht gefunden"; exit 1; }
done
docker compose version >/dev/null 2>&1 || { fail "'docker compose' nicht verfuegbar"; exit 1; }
[ -f docker-compose.yml ] || { fail "docker-compose.yml fehlt - Skript im Projektverzeichnis ausfuehren"; exit 1; }
[ -f .env ] || { fail ".env fehlt - ohne Konfiguration startet der Stack nicht"; exit 1; }
ok "git, docker compose, docker-compose.yml und .env vorhanden"

# Gebaut wird aus dem Arbeitsbaum, nicht aus dem Git-Index. Eine geloeschte
# nachverfolgte Datei laesst also den Build scheitern - unabhaengig davon, ob
# gezogen wird. Deshalb wird dieser Fall immer geprueft.
GELOESCHT="$(git ls-files --deleted 2>/dev/null || true)"
if [ -n "$GELOESCHT" ]; then
  fail "Diese nachverfolgten Dateien fehlen im Arbeitsverzeichnis:"
  echo "$GELOESCHT" | sed 's/^/           /' >&2
  echo "           Zurueckholen mit:" >&2
  echo "               git checkout -- $(echo "$GELOESCHT" | tr '\n' ' ')" >&2
  exit 1
fi

# Ein unsauberer Arbeitsbaum und "git pull --ff-only" vertragen sich nicht.
# Lieber hier abbrechen als mitten im Update auf einen Konflikt laufen - aber
# mit den Befehlen, die tatsaechlich weiterhelfen.
if [ "$DO_PULL" = "1" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  if [ "$STASH" = "1" ]; then
    info "Lokale Aenderungen beiseitelegen"
    git stash push --include-untracked -m "update.sh $STAMP_VORAB"
    STASH_GESETZT=1
    ok "Beiseitegelegt - Rueckholen mit 'git stash pop'"
  else
    fail "Es gibt lokale Aenderungen:"
    git status --short | sed 's/^/           /' >&2
    cat >&2 <<'AUSWEG'
           Moeglichkeiten:
             ./update.sh --stash        Aenderungen beiseitelegen und danach behalten
             git checkout -- <datei>    einzelne Aenderung verwerfen
             git stash push -u          alles beiseitelegen (spaeter: git stash pop)
             ./update.sh --no-pull      nur neu bauen, ohne zu ziehen
AUSWEG
    exit 1
  fi
fi

# --- Sicherung ---------------------------------------------------------------
STAMP="$STAMP_VORAB"
BACKUP_DIR="backups/$STAMP"

if [ "$SKIP_BACKUP" = "0" ]; then
  info "Sicherung nach $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"

  # Zugangsdaten aus .env lesen, sonst die Vorgaben aus docker-compose.yml.
  DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- || true)"
  DB_USER="$(printf '%s' "$DB_URL" | sed -n 's#^postgres\(ql\)\?://\([^:]*\):.*#\2#p')"
  DB_NAME="$(printf '%s' "$DB_URL" | sed -n 's#.*/\([^/?]*\)\(?.*\)\?$#\1#p')"
  DB_USER="${DB_USER:-user}"
  DB_NAME="${DB_NAME:-rag_db}"

  if docker compose ps --status running --services 2>/dev/null | grep -qx "rag-db"; then
    # Ohne --clean/--if-exists, damit die Sicherung auch in eine frische,
    # leere Datenbank eingespielt werden kann.
    if docker compose exec -T rag-db pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_DIR/postgres.sql.gz"; then
      ok "Datenbank gesichert ($(du -h "$BACKUP_DIR/postgres.sql.gz" | cut -f1), Benutzer $DB_USER, DB $DB_NAME)"
    else
      fail "pg_dump fehlgeschlagen - Update abgebrochen, es wurde nichts veraendert"
      exit 1
    fi
  else
    fail "Container rag-db laeuft nicht - ohne laufende Datenbank keine Sicherung"
    echo "           Stack starten ('docker compose up -d rag-db') oder --skip-backup nutzen" >&2
    exit 1
  fi

  # Originaldateien und Uploads liegen im Volume app-data und sind nicht aus der
  # Datenbank rekonstruierbar. Den echten Volume-Namen vom Container erfragen,
  # er haengt vom Compose-Projektnamen ab.
  APP_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' rag-ingestor-app 2>/dev/null || true)"
  if [ -z "$APP_VOLUME" ]; then
    APP_VOLUME="$(basename "$PWD" | tr '[:upper:]' '[:lower:]')_app-data"
    warn "Volume-Name geraten: $APP_VOLUME"
  fi

  if docker volume inspect "$APP_VOLUME" >/dev/null 2>&1; then
    docker run --rm \
      -v "$APP_VOLUME":/quelle:ro \
      -v "$PWD/$BACKUP_DIR":/ziel \
      alpine:3 tar czf /ziel/app-data.tar.gz -C /quelle . 2>/dev/null
    ok "Originaldateien gesichert ($(du -h "$BACKUP_DIR/app-data.tar.gz" | cut -f1), Volume $APP_VOLUME)"
  else
    warn "Volume $APP_VOLUME nicht gefunden - Originaldateien nicht gesichert"
  fi

  # Die .env ist nicht im Repository und waere bei einem Fehlgriff weg.
  cp .env "$BACKUP_DIR/env.backup"
  ok "Konfiguration (.env) gesichert"

  cat > "$BACKUP_DIR/WIEDERHERSTELLEN.md" <<WIEDERHERSTELLEN
# Wiederherstellung dieser Sicherung ($STAMP)

Datenbank (ersetzt den aktuellen Inhalt):

    docker compose up -d rag-db
    gunzip -c postgres.sql.gz | docker compose exec -T rag-db psql -U $DB_USER -d $DB_NAME

Originaldateien und Uploads:

    docker run --rm -v ${APP_VOLUME}:/ziel -v "\$PWD":/quelle:ro \\
      alpine:3 sh -c "rm -rf /ziel/* && tar xzf /quelle/app-data.tar.gz -C /ziel"

Konfiguration:

    cp env.backup ../../.env

Elasticsearch muss nicht gesichert werden - der Index laesst sich im Admin-UI
ueber "Reindex starten" vollstaendig aus PostgreSQL neu aufbauen.
WIEDERHERSTELLEN
  ok "Anleitung: $BACKUP_DIR/WIEDERHERSTELLEN.md"
else
  info "Sicherung uebersprungen (--skip-backup)"
  warn "Bei einem Fehlschlag gibt es keinen Rueckweg"
fi

# --- Code aktualisieren ------------------------------------------------------
if [ "$DO_PULL" = "1" ]; then
  info "Code aktualisieren"
  VORHER="$(git rev-parse --short HEAD)"
  # --ff-only: kein stiller Merge-Commit, kein halb aufgeloester Konflikt.
  if ! git pull --ff-only; then
    fail "git pull fehlgeschlagen (kein Fast-Forward moeglich)"
    echo "           Lokale Commits mit 'git log --oneline origin/HEAD..HEAD' pruefen" >&2
    exit 1
  fi
  NACHHER="$(git rev-parse --short HEAD)"
  if [ "$VORHER" = "$NACHHER" ]; then
    ok "Bereits aktuell ($NACHHER)"
  else
    ok "$VORHER -> $NACHHER"
    git log --oneline "$VORHER..$NACHHER" | sed 's/^/           /'
  fi
else
  info "git pull uebersprungen (--no-pull)"
fi

# --- Neue Konfigurationsschluessel melden ------------------------------------
if [ -f .env.example ]; then
  FEHLEND="$(grep -oE '^[A-Z_][A-Z0-9_]*=' .env.example | tr -d '=' | while read -r key; do
    grep -qE "^${key}=" .env || echo "$key"
  done)"
  if [ -n "$FEHLEND" ]; then
    info "Neue Konfigurationsschluessel"
    warn "In .env fehlen (es greifen die Vorgaben aus dem Code):"
    echo "$FEHLEND" | sed 's/^/           /'
  fi
fi

# --- Bauen und starten -------------------------------------------------------
info "Images bauen"
docker compose build ingestor-app ingestor-worker ragfind
ok "Build abgeschlossen"

info "Container starten"
# Kein "down": die Volumes und damit alle Daten bleiben unangetastet.
# Datenbankmigrationen laufen beim Start der Anwendung automatisch.
docker compose up -d
ok "Container gestartet"

# --- Pruefen -----------------------------------------------------------------
info "Pruefung"

PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2- || true)"
PORT="${PORT:-3311}"

BEREIT=0
for _ in $(seq 1 60); do
  # 401 zaehlt als erreichbar: /api/status verlangt Admin-Auth, die Anwendung
  # antwortet also bereits.
  CODE="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://localhost:${PORT}/api/status" 2>/dev/null || echo 000)"
  case "$CODE" in
    200|401) BEREIT=1; break ;;
  esac
  sleep 2
done

if [ "$BEREIT" = "1" ]; then
  ok "Anwendung antwortet auf Port $PORT"
else
  fail "Anwendung antwortet nach 120 s nicht"
  echo "           Logs: docker compose logs --tail 50 ingestor-app" >&2
  exit 1
fi

NICHT_OBEN="$(docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk '$2 != "running" {print $1}')"
if [ -n "$NICHT_OBEN" ]; then
  fail "Diese Dienste laufen nicht:"
  echo "$NICHT_OBEN" | sed 's/^/           /' >&2
  exit 1
fi
ok "Alle Dienste laufen"

# Migrationen laufen beim Start; ein Fehler dabei wuerde die Anwendung stoppen,
# trotzdem hier gegenpruefen, ob die juengste Migration angekommen ist.
LETZTE_MIGRATION="$(ls migrations/*.sql 2>/dev/null | sort | tail -1)"
if [ -n "$LETZTE_MIGRATION" ]; then
  ok "Migrationen bis $(basename "$LETZTE_MIGRATION") im Image enthalten und beim Start angewandt"
fi

if [ "$STASH_GESETZT" = "1" ]; then
  info "Beiseitegelegte Aenderungen zurueckholen"
  if git stash pop; then
    ok "Zurueckgeholt"
  else
    warn "Konflikt beim Zurueckholen - die Aenderungen liegen weiter in 'git stash list'"
  fi
fi

info "Fertig"
if [ "$SKIP_BACKUP" = "0" ]; then
  echo "    Sicherung: $BACKUP_DIR"
fi
cat <<'HINWEIS'
    Manuelle Schritte, falls das Update Suche oder Embeddings betrifft:
      - Admin-UI -> "Reindex starten"        (nach Aenderungen am Elasticsearch-Mapping)
      - Admin-UI -> "Re-Embedding starten"   (nach Aenderungen am Embedding-Input)
    Beides steht im jeweiligen Release-Hinweis bzw. in optimierungsplan.md.
HINWEIS
