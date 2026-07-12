#!/bin/sh
# Container entrypoint for the `app` service (see ../Dockerfile, ../docker-compose.yml).
#
# 1. Applies any committed-but-unapplied Prisma migrations (idempotent — safe
#    to run on every container start/restart, including rolling updates).
# 2. execs into the standalone Next.js server (`CMD ["node", "server.js"]`,
#    passed through as "$@") so it becomes PID 1 and receives signals
#    directly (clean `docker compose stop` / restart).
#
# Runs as the non-root `node` user (see Dockerfile). `prisma migrate deploy`
# only applies prisma/migrations/* — it never touches the optional pgvector
# column/index from prisma/sql/enable-pgvector.sql; that stays a one-time
# manual step (see docs/DEPLOY.md) so byte-identical embeddings already in
# the database are never disturbed by an automatic deploy.
set -eu

echo "[entrypoint] running prisma migrate deploy..."
# node_modules/.bin/prisma is symlinked at build time (see Dockerfile) so
# this resolves the CLI already baked into the image — no network fetch.
npx prisma migrate deploy

echo "[entrypoint] starting server: $*"
exec "$@"
