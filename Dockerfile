# syntax=docker/dockerfile:1
#
# Multi-stage production image for YayAssist's self-hosting kit.
#
# Stages:
#   deps    — install full (incl. dev) npm dependencies, cached by lockfile.
#   builder — generate the Prisma client and build Next.js in standalone
#             output mode (BUILD_STANDALONE=1, see next.config.ts).
#   runner  — slim runtime: the traced standalone server plus the static
#             assets, Prisma schema/migrations, and the Prisma engine
#             binaries `prisma migrate deploy` needs at container start.
#
# All three stages pin the same Debian base (bookworm-slim) so the Prisma
# query/schema engine binaries built in `builder` (debian-openssl-3.0.x) are
# the exact ones that run in `runner` — no prisma `binaryTargets` juggling
# needed. Pin the Node major to match "engines": ">=20" in package.json.
ARG NODE_IMAGE=node:20-bookworm-slim

# ─────────────────────────────────────────────────────────────────────────
# deps — install once, reused by the builder unless package*.json changes.
# ─────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ─────────────────────────────────────────────────────────────────────────
# builder — compile the Next.js standalone server.
# ─────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# `next build` imports every route module (even force-dynamic ones) to build
# the route manifest, which instantiates src/lib/db.ts's module-scope
# `new PrismaClient()`. Prisma reads DATABASE_URL at construction time (not
# connection time), so it must be *some* syntactically valid URL at build —
# no query actually runs at build time (every page/route in this app is
# force-dynamic), and this placeholder never leaves the builder stage. The
# real value is supplied to the `app` container at runtime via env_file.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# BUILD_STANDALONE=1 flips on `output: "standalone"` in next.config.ts (kept
# off by default so plain local `npm run build` is unaffected). The build
# script (package.json) runs `prisma generate && next build`.
ENV BUILD_STANDALONE=1
RUN npm run build
# Standalone output only copies a `public/` directory if one exists at build
# time; this repo doesn't ship one today. Ensure the COPY below always has a
# source so the image builds the same whether or not that changes later.
RUN mkdir -p /app/public

# ─────────────────────────────────────────────────────────────────────────
# runner — slim runtime image, non-root.
# ─────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The official Node image already ships an unprivileged `node` user
# (uid/gid 1000) — reuse it instead of minting a new one.

# Next's standalone output: server.js + a pruned node_modules + .next/ server
# chunks (no static assets, no public/ — copied separately below).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# prisma/ (schema + migrations + sql/) so `prisma migrate deploy` has
# something to apply against DATABASE_URL at container start.
COPY --from=builder --chown=node:node /app/prisma ./prisma

# Standalone's file tracing follows the imports Next itself sees, which can
# miss Prisma's dynamically-loaded native engine binaries. Copy the Prisma
# packages explicitly so both the query engine (app runtime) and the schema
# engine (migrate deploy, run by the entrypoint below) are present without
# reaching out to the network at container start:
#   node_modules/.prisma   — generated client + query engine (src/lib/db.ts)
#   node_modules/@prisma/* — client package, engines, engines-version, debug
#   node_modules/prisma    — the CLI itself (`prisma migrate deploy`)
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
RUN mkdir -p node_modules/.bin && \
    ln -sf ../prisma/build/index.js node_modules/.bin/prisma && \
    chown -h node:node node_modules/.bin/prisma

COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

USER node
EXPOSE 3000

# No curl/wget in this slim image — Node 20 has a global `fetch`, so the
# compose healthcheck (see docker-compose.yml) shells out to `node -e`
# instead of installing an extra package.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["node", "server.js"]
