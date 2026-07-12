#!/usr/bin/env bash
# Restore a custom-format (-Fc) pg_dump — produced by scripts/backup.sh, or
# by `pg_dump -Fc` run directly against the old Mac dev database — into the
# running `db` compose service.
#
# Usage:
#   scripts/restore.sh <path-to-dump-file>
#   scripts/restore.sh <path-to-dump-file> --force   # skip the empty-db guard
#
# This does a FULL restore (schema + data, via pg_restore with no
# --data-only) and, by default, refuses to run against a database that
# already has tables. That's deliberate: see docs/DEPLOY.md "Migrating
# data" for why restoring into an EMPTY database is the byte-safe way to
# bring over pgvector embeddings, rather than running `prisma migrate
# deploy` first and restoring --data-only on top. --force drops and
# recreates the public schema first — only pass it when you mean it.
set -euo pipefail

usage() {
  echo "Usage: $0 <path-to-dump-file> [--force]" >&2
  exit 1
}

[ $# -ge 1 ] || usage
DUMP_FILE_ARG="$1"
FORCE_FLAG="${2:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

[ -f "$DUMP_FILE_ARG" ] || { echo "[restore] dump file not found: $DUMP_FILE_ARG" >&2; exit 1; }
DUMP_FILE="$(cd "$(dirname "$DUMP_FILE_ARG")" && pwd)/$(basename "$DUMP_FILE_ARG")"

ENV_FILE="$REPO_ROOT/.env.production"
if [ ! -f "$ENV_FILE" ]; then
  echo "[restore] missing $ENV_FILE — copy .env.production.example and fill it in first." >&2
  exit 1
fi
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

: "${POSTGRES_USER:?POSTGRES_USER not set in .env.production}"
: "${POSTGRES_DB:?POSTGRES_DB not set in .env.production}"

if ! docker compose ps db 2>/dev/null | grep -q .; then
  echo "[restore] the 'db' service doesn't look like it's running (docker compose ps db) — aborting" >&2
  exit 1
fi

TABLE_COUNT_RAW="$(docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "select count(*) from information_schema.tables where table_schema = 'public'")"
TABLE_COUNT="$(echo "$TABLE_COUNT_RAW" | tr -d '[:space:]')"

if [ "$TABLE_COUNT" != "0" ] && [ "$FORCE_FLAG" != "--force" ]; then
  echo "[restore] refusing: database '$POSTGRES_DB' already has $TABLE_COUNT table(s)." >&2
  echo "[restore] this restore recreates the schema from the dump and expects an EMPTY database" >&2
  echo "[restore] (see docs/DEPLOY.md 'Migrating data'). Re-run with --force only if you understand" >&2
  echo "[restore] this drops every existing table in '$POSTGRES_DB' first." >&2
  exit 1
fi

if [ "$TABLE_COUNT" != "0" ]; then
  echo "[restore] --force: dropping and recreating the public schema of '$POSTGRES_DB'"
  docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
fi

echo "[restore] restoring $DUMP_FILE -> $POSTGRES_DB"
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges < "$DUMP_FILE"

echo "[restore] done. Sanity-check with:"
echo "  docker compose exec db psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -c '\\dt'"
echo "[restore] now start (or restart) the app so its entrypoint runs 'prisma migrate deploy' and"
echo "[restore] catches this database up to any migrations newer than the dump:"
echo "  docker compose up -d app"
