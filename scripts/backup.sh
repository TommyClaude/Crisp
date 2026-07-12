#!/usr/bin/env bash
# Daily backup of the YayAssist Postgres database.
#
# Runs `pg_dump -Fc` (custom format — required for scripts/restore.sh's
# pg_restore, and much smaller than plain SQL) inside the running `db`
# compose service, writes the result to ./backups/, and prunes dumps older
# than 14 days. No psql/pg_dump needed on the host — only `docker compose`.
#
# Usage (from the repo root, or anywhere — it cd's to its own repo):
#   scripts/backup.sh
#
# Cron (see docs/DEPLOY.md "Backups"):
#   0 3 * * *  /path/to/app/scripts/backup.sh >> /path/to/app/backups/backup.log 2>&1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="$REPO_ROOT/.env.production"
if [ ! -f "$ENV_FILE" ]; then
  echo "[backup] missing $ENV_FILE — copy .env.production.example and fill it in first." >&2
  exit 1
fi
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

: "${POSTGRES_USER:?POSTGRES_USER not set in .env.production}"
: "${POSTGRES_DB:?POSTGRES_DB not set in .env.production}"

BACKUP_DIR="$REPO_ROOT/backups"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$BACKUP_DIR/yayassist-$TIMESTAMP.dump"

mkdir -p "$BACKUP_DIR"

if ! docker compose ps db 2>/dev/null | grep -q .; then
  echo "[backup] the 'db' service doesn't look like it's running (docker compose ps db) — aborting" >&2
  exit 1
fi

echo "[backup] dumping '$POSTGRES_DB' -> $OUT_FILE"
# -T: no pseudo-TTY — required for a clean binary stream over `exec`'s stdout.
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$OUT_FILE"

# Sanity check: a real custom-format dump always starts with Postgres's
# "PGDMP" magic bytes. Catches a silently empty/garbled file (e.g. db was
# actually down and pg_dump's error text landed in the file) before it can
# displace a good backup during rotation below.
if ! head -c 5 "$OUT_FILE" | grep -q "PGDMP"; then
  echo "[backup] ERROR: $OUT_FILE doesn't look like a valid pg_dump custom-format file — removing it" >&2
  rm -f "$OUT_FILE"
  exit 1
fi

ln -sf "$(basename "$OUT_FILE")" "$BACKUP_DIR/latest.dump"

echo "[backup] pruning dumps older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -name 'yayassist-*.dump' -mtime "+$RETENTION_DAYS" -print -delete

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "[backup] done: $OUT_FILE ($SIZE)"
