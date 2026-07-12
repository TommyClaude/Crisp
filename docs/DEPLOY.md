# Deploying YayAssist

This is the self-hosting kit for running YayAssist in production, reachable
over the internet by your support team, instead of on someone's Mac via
`npm run dev`. It covers two shapes:

- **Option 1 — VPS**, with a real domain and Caddy terminating TLS automatically.
- **Option 2 — Mac mini** (or any machine on a home/office network with no
  public IP), with [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  punching a hole out instead of opening any inbound port.

Both run the same `docker-compose.yml` — a Postgres (`db`, pgvector-enabled),
the app (`app`), and, VPS-only, a reverse proxy (`caddy`, behind the
`vps` [Compose profile](https://docs.docker.com/compose/how-tos/profiles/)).

Also covered: migrating your existing Mac dev database over (preserving
pgvector embeddings byte-for-byte), backups, updates, and troubleshooting.

## Prerequisites for either option

- The repo checked out on the target machine (`git clone …` or `git pull` if
  it's already there).
- `cp .env.production.example .env.production`, then fill it in:
  - `POSTGRES_PASSWORD` and `BASIC_AUTH_PASSWORD` — generate real random
    values, e.g. `openssl rand -base64 24`. **Do not ship the example
    defaults.**
  - `DATABASE_URL` — keep its password in sync with `POSTGRES_PASSWORD`
    (env files aren't shell-interpolated, so these are two independent
    lines you must edit consistently — see the comment at the top of the
    file).
  - `APP_DOMAIN` — your public hostname (VPS path only; harmless to leave
    set on a Mac mini).
  - The Crisp / OpenAI / Anthropic / `WPORG_MAIL_*` variables you actually
    use — all optional, see the comments in the file and the main
    [README](../README.md#environment-variables).
- `.env.production` is gitignored — it never gets committed, on either box.

## Option 1 — VPS

For a small support team's traffic, a **2 GB RAM / 1 vCPU Ubuntu 22.04 or
24.04** droplet/instance is plenty (Postgres + a single Next.js server).

1. **Install Docker** (official convenience script — see
   [docs](https://docs.docker.com/engine/install/ubuntu/#install-using-the-convenience-script)
   before piping any install script to `sh` on a box you care about):

   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker "$USER"
   # log out and back in (or `newgrp docker`) for the group change to apply
   ```

2. **Point DNS at the box.** Create an A record (and AAAA if you have IPv6)
   for `support.example.com` → the VPS's public IP. Caddy's automatic HTTPS
   (next step) needs this to already resolve before it can request a
   certificate.

3. **Open the firewall** for HTTP/HTTPS (and keep SSH open):

   ```bash
   sudo ufw allow 22/tcp
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

4. **Fill in `.env.production`** as described in Prerequisites above —
   `APP_DOMAIN` must match the DNS record from step 2.

5. **Bring it up** with the `vps` profile, which adds the `caddy` service:

   ```bash
   docker compose --profile vps up -d --build
   ```

   First boot: `db` builds its data volume and reports healthy, `app` runs
   `prisma migrate deploy` (see `docker/entrypoint.sh`) then starts, and
   `caddy` requests a Let's Encrypt certificate for `APP_DOMAIN` on its
   first incoming request — no manual certbot/ACME setup. Give it a minute,
   then:

   ```bash
   curl https://support.example.com/api/health
   # {"ok":true,"db":true}
   ```

   Log into the app itself at `https://support.example.com` with
   `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` from `.env.production`.

Caddy's cert + its ACME account key live in the `caddy_data` named volume
(see `docker-compose.yml`) — it survives `docker compose down` (without
`-v`) and container rebuilds, so you won't hit Let's Encrypt's rate limits
by redeploying.

## Option 2 — Mac mini (home / office, no public IP)

Same app, same `docker-compose.yml`, but instead of Caddy answering the
public internet directly, [Cloudflare
Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
makes an outbound-only connection from the Mac mini to Cloudflare's edge —
no port forwarding, no router config, works behind CGNAT. Requires a domain
already on Cloudflare (free tier is fine).

1. **Install Docker** on the Mac — either [Docker
   Desktop](https://www.docker.com/products/docker-desktop/) or, for a
   lighter always-on box, [Colima](https://github.com/abiosoft/colima):

   ```bash
   brew install colima docker docker-compose
   colima start
   ```

2. **Fill in `.env.production`** as described in Prerequisites. `APP_DOMAIN`
   is unused here (the `caddy` service never starts) but harmless to set.

3. **Bring it up WITHOUT the `vps` profile** — this is the only difference
   from Option 1's compose command, and it's what skips `caddy` entirely:

   ```bash
   docker compose up -d --build
   ```

   `app` publishes on `127.0.0.1:3000` only (see `docker-compose.yml`) —
   exactly what the tunnel points at next. Confirm it locally first:

   ```bash
   curl http://localhost:3000/api/health
   # {"ok":true,"db":true}
   ```

4. **Install and configure `cloudflared`:**

   ```bash
   brew install cloudflared
   cloudflared tunnel login          # opens a browser, pick your domain's Cloudflare account
   cloudflared tunnel create yayassist
   cloudflared tunnel route dns yayassist support.example.com
   ```

   `tunnel create` prints a tunnel ID and writes credentials to
   `~/.cloudflared/<TUNNEL_ID>.json`. Create `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: <TUNNEL_ID>
   credentials-file: /Users/<you>/.cloudflared/<TUNNEL_ID>.json
   ingress:
     - hostname: support.example.com
       service: http://localhost:3000
     - service: http_status:404
   ```

5. **Install it as a service** so it survives reboots and login/logout, then
   confirm it's live:

   ```bash
   sudo cloudflared service install
   curl https://support.example.com/api/health
   ```

6. **Keep the Mac mini awake.** In System Settings → Energy, disable sleep
   while plugged in (and enable Power Nap / "Wake for network access" if
   available) — otherwise the tunnel drops whenever the machine sleeps.

**Optional — Cloudflare Access in front of Basic Auth.** The app's own
Basic Auth (`BASIC_AUTH_USER`/`PASSWORD`) is already enough to gate it, but
if you'd rather your team log in with their existing Google/Microsoft/email
identity instead of sharing one password: in the Cloudflare Zero Trust
dashboard, add a **Self-hosted** Access application for
`support.example.com`, and add a policy allowing your team's specific
emails (or an email domain, e.g. `@yourcompany.com`). Access then challenges
visitors *before* the request ever reaches the app; Basic Auth still runs
underneath as a second layer, so keep it configured.

## Migrating data from the current Mac dev database

Your current setup already has real, RAG-indexed conversation history — and
if you've run `prisma/sql/enable-pgvector.sql`, real OpenAI embeddings in
the `embedding vector(1536)` column, which cost real money and time to
generate. This recipe brings all of it over **without regenerating
anything**.

**The safe recipe is: dump the whole database, then restore it in full into
a freshly-created, empty database — not `prisma migrate deploy` first
followed by a `--data-only` restore.** Why the full restore wins:

- A full `pg_dump -Fc` captures the *exact* schema as it exists today,
  including the `vector(1536)` column and its data, the pgvector
  `CREATE EXTENSION` statement (if you ran it), the IVFFlat index, and — not
  incidentally — the `_prisma_migrations` table itself, which is what tells
  Prisma which migrations are already applied.
- `pg_restore` into an **empty** database just replays that exact schema:
  there's nothing to conflict with, no partially-applied migration state,
  and no chance of a column type/constraint mismatch between "what the dump
  expects" and "what today's `prisma/migrations` folder would create".
- Running `prisma migrate deploy` **first** creates the schema as defined by
  whatever migrations are in the repo **right now** — which may already be
  ahead of what your Mac's database last had — and then a `--data-only`
  restore has to thread that gap (renamed/added columns, new constraints),
  which is exactly the kind of thing that silently drops or rejects rows.
- After the full restore, starting `app` normally runs `prisma migrate
  deploy` anyway (`docker/entrypoint.sh`) — since the dump's
  `_prisma_migrations` table already lists everything up to the point you
  dumped it, this is a safe no-op unless the repo has genuinely newer
  migrations, in which case it applies just those, forward-only, onto data
  that's already there. Embeddings are never touched.

### Steps

1. **On the current Mac dev box**, dump the live database (adjust user/host
   to match your local `DATABASE_URL`):

   ```bash
   pg_dump -Fc -h localhost -U crisp -d crisp_sync -f yayassist-migration.dump
   ```

   (`scripts/backup.sh` does the equivalent for a *dockerized* `db` — the
   Mac dev DB predates the container, so use plain `pg_dump` directly here.)

2. **Copy the dump to the new host:**

   ```bash
   scp yayassist-migration.dump you@newhost:/path/to/app/backups/
   ```

3. **On the new host**, start only Postgres first:

   ```bash
   docker compose up -d db
   docker compose ps db   # wait for "healthy"
   ```

4. **Restore** with `scripts/restore.sh`, which refuses to run if the target
   database already has tables (so a re-run can't silently clobber a live
   install):

   ```bash
   scripts/restore.sh backups/yayassist-migration.dump
   ```

   If your Mac database had pgvector enabled, the restore recreates the
   extension and the `embedding` column exactly as they were — no manual
   `CREATE EXTENSION` step is needed, because the dump already contains it.
   If you want to double check it landed (or you're enabling pgvector for
   the *first* time on the new host, having only used the `embeddingJson`
   fallback before):

   ```bash
   docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dx"
   # should list "vector" if the dump had it enabled

   # only if you need to enable it fresh (see prisma/sql/enable-pgvector.sql):
   cat prisma/sql/enable-pgvector.sql | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
   ```

5. **Start the app** — its entrypoint runs `prisma migrate deploy` against
   the now-populated database before serving traffic:

   ```bash
   docker compose up -d app          # Mac mini path
   docker compose --profile vps up -d app   # VPS path
   ```

6. Spot-check: log in, confirm conversation counts on `/dashboard` match
   what you expected, and that `/rag` search still returns results (proof
   the embeddings survived).

## Backups + cron

`scripts/backup.sh` runs `pg_dump -Fc` (custom format) inside the running
`db` container via `docker compose exec`, writes to `./backups/`, and keeps
the last 14 days (override with `BACKUP_RETENTION_DAYS`). `scripts/restore.sh`
is its counterpart — see the migration recipe above for how it's meant to be
used (full restore into an empty database).

Add a system crontab entry (`crontab -e`) for a nightly backup:

```cron
0 3 * * *  /path/to/app/scripts/backup.sh >> /path/to/app/backups/backup.log 2>&1
```

**Optional — forum-check cron.** The wp.org email-push listener
(`WPORG_MAIL_*`, started automatically from `src/instrumentation.ts` when
configured — see the README) already drives near-realtime forum checks, so
this is a belt-and-suspenders fallback (or your only mechanism, if you don't
use the mail listener). The production image doesn't ship the `tsx`
CLI scripts (`npm run wporg:check` is a dev/bare-metal convenience — the
standalone Docker runtime only contains the built server), so drive it over
HTTP instead. It's the same [`POST /api/wporg/check`](../README.md#api-reference)
route the dashboard's "Check forums" button calls, protected by the same
Basic Auth as everything else:

```cron
0 * * * *  curl -fsS -u admin:change-me -X POST https://support.example.com/api/wporg/check >/dev/null 2>&1
```

(Swap in your real `BASIC_AUTH_USER`/`PASSWORD` and domain. Hourly is a
reasonable default since the mail listener, if enabled, already covers the
"near-realtime" case — this cron is a safety net for anything the mailbox
setup misses.)

## Updating the app

```bash
cd /path/to/app
git pull
docker compose build app
docker compose up -d app                   # Mac mini
docker compose --profile vps up -d app     # VPS (equivalent; --profile is
                                            # only needed if you also changed
                                            # docker/Caddyfile and want caddy
                                            # picked up in the same command)
```

The entrypoint re-runs `prisma migrate deploy` on every start, so any new
migrations in the pulled code apply automatically before the server starts
serving. Rolling this out drops the old container and starts a new one —
expect a few seconds of downtime (no blue/green in this kit). Optionally
clean up old image layers afterwards: `docker image prune -f`.

## Troubleshooting

- **Is it up at all?** `docker compose ps` — look for `healthy` on both `db`
  and `app` (and `caddy`, VPS only). `unhealthy`/`starting` forever usually
  means check the logs next.
- **Health route:** `curl https://<domain>/api/health` (or
  `http://localhost:3000/api/health` on the Mac mini, or from inside the
  network) — `{"ok":true,"db":true}` means the app process is up *and* it
  can reach Postgres. `{"ok":false,"db":false}` with a 503 means the app is
  up but Postgres isn't reachable — check `db`'s logs and that
  `DATABASE_URL` in `.env.production` matches `POSTGRES_PASSWORD`.
- **Logs:**
  ```bash
  docker compose logs -f app     # server startup, prisma migrate deploy output,
                                  # instrumentation/mail-listener activity
  docker compose logs -f db
  docker compose logs -f caddy   # VPS only — cert issuance/renewal, proxy errors
  ```
- **401 on every page:** expected without credentials — Basic Auth protects
  everything except `/api/health` (see `src/middleware.ts`). Confirm
  `BASIC_AUTH_USER`/`PASSWORD` in `.env.production` match what you're typing.
- **503 "Server misconfigured" on every page:** `BASIC_AUTH_USER`/`PASSWORD`
  are unset in the running container — check `.env.production` was actually
  picked up (`docker compose config` prints the resolved env for each
  service; re-run `docker compose up -d` after editing the file so it's
  re-read).
- **Caddy won't get a certificate (VPS):** confirm `APP_DOMAIN` in
  `.env.production` actually resolves to this box's IP
  (`dig +short support.example.com`) and that ports 80/443 are open in the
  firewall/cloud security group — Let's Encrypt's HTTP-01 challenge needs
  port 80 reachable from the internet, not just 443.
- **Mail listener status:** `GET /api/wporg/mail/status` (Basic Auth
  required, same as everything else) reports the IMAP listener's live
  `status` (`disabled` / `connecting` / `listening` / `error`), `lastError`,
  and `eventsProcessed`:
  ```bash
  curl -u admin:change-me https://support.example.com/api/wporg/mail/status
  ```
  `disabled` is expected and fine unless you set `WPORG_MAIL_ENABLED=true` —
  it only starts when `WPORG_MAIL_ENABLED=true` and both `WPORG_MAIL_USER`
  and `WPORG_MAIL_PASSWORD` are set (see `src/env.ts`). Changing those values
  needs a real container restart (`docker compose up -d app`) to take
  effect — `POST /api/wporg/mail/restart` only reconnects with whatever env
  was already loaded.
- **Migration failed on startup:** `docker compose logs app` shows the
  `prisma migrate deploy` output right at the top of the container's log —
  it's the first thing the entrypoint runs. A failed migration exits the
  container immediately (it never starts serving on a half-migrated schema).
