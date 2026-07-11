# YayAssist

**AI answer suggestions for support teams.** YayAssist watches the wordpress.org support forums of your plugins and drafts replies for your supporters to review — grounded in what the AI has learned from your historical [Crisp.chat](https://crisp.chat) conversations and product documentation (RAG, no fine-tuning).

Crisp is a *data source* here, not the product: the tool syncs every support conversation from the Crisp REST API into your own Postgres database (browsable in a chat-log UI), crawls your docs sites into the same knowledge index, and uses both to suggest answers. Nothing is ever posted automatically — supporters review, copy, and post.

## Features

- **Sync engine** — full and incremental syncs of all conversations, messages, attachments and operators. Global rate limiting with exponential backoff, page-level resumability, graceful cancellation, per-run `SyncLog` history and failed-session tracking. Run from the CLI, cron, or dashboard buttons.
- **Crisp-like chat log UI** — paginated, filterable conversation list (state, tag, product, operator, email, attachments, date range, free-text search) and a message-by-message conversation view with attachments and visitor metadata.
- **3-tier RAG search** — pgvector ANN search when available, in-app cosine ranking over JSON-stored embeddings when not, and Postgres full-text keyword search when no OpenAI key is configured. The best available tier is picked automatically at query time.
- **PII redaction** — emails, phone numbers, card numbers (Luhn-validated), API keys/tokens, license keys/UUIDs and passwords are redacted from all embedding chunks before anything is vectorized. Raw data stays in the database only. PII shown in the UI is masked.
- **Product detection** — conversations are tagged with the plugin/product they are about using keyword heuristics where specific plugins beat platform-level matches. Detection definitions come from the plugins you manage in `/plugins` (name + keywords); a built-in list (FileBird, YayMail, YayCurrency, YaySMTP, Brandy, YayCommerce, WooCommerce, WordPress) is the fallback for a fresh install.
- **Multi-brand sync** — one `Brand` per Crisp website (e.g. YayCommerce, Ninja Team, CatFolders...), managed in `/brands`. The sync iterates every brand with a single plugin token; conversations are linked to their brand and filterable by it. A brand can also carry its wordpress.org author username (`wpProfileSlug`), enabling **one-click plugin import** — pull every plugin that author publishes on WordPress.org and create a Plugin (+ idle forum Q&A source) for each, skipping ones you already have.
- **wp.org forum watcher + answer suggester** — polls each plugin's WordPress.org support-forum feed (`wpOrgSlug`), stores new topics, retrieves the most relevant past conversations + docs via RAG, and (when an LLM provider is configured) drafts a reply for human review in `/suggestions`. Drafts are **never** posted automatically. Provider-agnostic: with `SUGGESTER_PROVIDER=auto` (default) it drafts from **every** configured provider — set both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` and each "Regenerate drafts" produces an Anthropic *and* an OpenAI draft side by side to compare and pick from. Pin a single provider with `SUGGESTER_PROVIDER=anthropic|openai`. With no key configured the page still shows the retrieved grounding context.
- **Follow-up reply drafts** — the side-by-side drafts answer a topic's *first* post. Clicking **Regenerate** on a topic *additionally* fetches the whole live thread from wordpress.org and drafts the **next** reply the support team should post — grounded on the same RAG context but keyed on the newest customer message, and shown in a distinct amber box below the first-reply drafts (one card per provider, with Copy). This whole-thread pass runs **only** on the manual Regenerate action; the bulk "Generate missing drafts", the feed watcher, and every auto-draft path keep the cheaper first-reply-only behavior for cost control. Topics with no replies yet, or threads that can't be fetched, show a short note instead of drafts.
- **Answer-quality playground** — the `/test-answer` page runs a hypothetical support question (title + body, like a wp.org topic) through the exact RAG retrieval + multi-provider drafting pipeline the forum watcher uses, without creating a `SupportThread` — nothing is persisted, so you can test answer quality against the current knowledge base at any time.
- **Docs ingestion** — each plugin can register documentation sources (a URL to crawl or a sitemap). Ingestion crawls the pages (same-origin, same path prefix, max 200 pages), extracts clean text, chunks + embeds it into the same RAG index with `source="plugin_docs"`, and re-crawls incrementally (unchanged pages keep their chunks; removed pages are pruned). RAG search can mix chat and docs results or filter by source.
- **wp.org forum Q&A ingestion** — the assistant also learns from the plugin's own support forum. A source of type `wporg_forum` (auto-created when a plugin has a `wpOrgSlug`, and auto-detected when you paste a `wordpress.org/support/plugin/…` URL) walks the forum listing, fetches every **answered** topic (up to 200 newest per run, following reply pagination), and stores each one as a Q&A transcript — question + replies with wp.org roles (`Plugin Author`, `Plugin Support`) and a `[Resolved]` marker preserved. Topics with no replies and sticky announcements are skipped. Transcripts are PII-redacted, chunked and embedded with `source="wporg_forum"`, and forum history **accumulates**: topics that scroll past the crawl window on later runs are kept. Re-running Ingest only processes new/changed topics.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 15.5 (App Router), React 19, TypeScript (strict) |
| Database | PostgreSQL + Prisma 6 (optional pgvector extension) |
| Styling | Tailwind CSS v4 (CSS-first config), shadcn/ui-style components, lucide-react |
| Validation | Zod (env + API inputs) |
| Embeddings | OpenAI `text-embedding-3-small` (optional, 1536 dims) |
| Scripts | tsx CLI scripts for sync / chunk rebuild / demo seed |

## Quick start

Prerequisites: **Node 20+** and **PostgreSQL 14+**.

```bash
npm install
cp .env.example .env         # fill in Crisp credentials + DATABASE_URL
npx prisma migrate deploy    # create the schema
npm run dev                  # http://localhost:3000
```

Then either run a real sync (`npm run sync:crisp`, needs Crisp credentials) or load fake data with `npm run seed:demo` to explore the UI immediately.

## Crisp API tokens (per brand)

Each brand is a separate Crisp **website**, and a Crisp REST API token only reaches its own website. So every brand gets its own token, entered in the `/brands` UI (the key is stored AES-256-GCM encrypted; `CREDENTIALS_SECRET` is the encryption secret).

To create a token for one website:

1. In the Crisp app, open that website, then **Website Settings → Advanced configuration**.
2. Under **REST API + MCP Server Tokens**, click **Create Token**. When prompted for scopes, grant read access to conversations (`website:conversation:sessions`, `website:conversation:messages`).
3. Copy the **Identifier** and **Key**.
4. In YayAssist, go to `/brands`, add the brand (or click **Set token** on an existing one), paste the two values, and click **Test** to confirm the token reaches the website.
5. Find the **website ID** in the Crisp app URL (`app.crisp.chat/website/<website_id>/...`) — enter it as the brand's Crisp website ID.

> A single token that spans multiple websites requires a **public** Marketplace plugin (Crisp review). For an internal tool, per-website tokens are simpler. The global `CRISP_IDENTIFIER`/`CRISP_KEY` in `.env` remain as an optional fallback for brands without their own token.

## Environment variables

Copy `.env.example` to `.env`. Validated at startup by `src/env.ts` (Zod) — invalid config fails fast with a readable error.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CRISP_WEBSITE_ID` | no (legacy) | — | Single-website fallback, used only when no brands exist yet. Prefer adding brands (one per Crisp website) in `/brands` |
| `CREDENTIALS_SECRET` | no | `BASIC_AUTH_PASSWORD` | Secret to encrypt per-brand Crisp keys at rest (AES-256-GCM). Set a dedicated random value in production |
| `CRISP_IDENTIFIER` | no | — | Global fallback token identifier. Brands normally carry their own token (see below); used only for brands without one |
| `CRISP_KEY` | no | — | Global fallback token key. Per-brand tokens (managed in `/brands`) take precedence |
| `DATABASE_URL` | yes | — | Postgres connection URL |
| `OPENAI_API_KEY` | no | empty | Enables embedding generation for vector/hybrid RAG search. Unset → keyword search only |
| `OPENAI_EMBEDDING_MODEL` | no | `text-embedding-3-small` | Embedding model (1536 dimensions) |
| `SUGGESTER_PROVIDER` | no | `auto` | LLM for forum-reply drafts: `auto` \| `anthropic` \| `openai` |
| `ANTHROPIC_API_KEY` | no | — | Enables Anthropic drafts (`auto` prefers it when set) |
| `ANTHROPIC_MODEL` | no | `claude-opus-4-8` | Anthropic model for drafts |
| `OPENAI_CHAT_MODEL` | no | `gpt-4o-mini` | OpenAI model for drafts (uses `OPENAI_API_KEY`) |
| `WPORG_FEED_BASE` | no | `https://wordpress.org/support/plugin` | Forum feed base URL (tests only) |
| `BASIC_AUTH_USER` | prod: yes | — | Admin UI/API Basic auth username |
| `BASIC_AUTH_PASSWORD` | prod: yes | — | Admin UI/API Basic auth password |
| `CRISP_REQUEST_INTERVAL_MS` | no | `150` | Minimum delay between Crisp API requests (ms) |
| `CRISP_MAX_RETRIES` | no | `5` | Max retries for retryable Crisp API failures |

## Database & migrations

```bash
npx prisma migrate deploy   # apply committed migrations (CI / production / first setup)
npx prisma migrate dev      # develop new migrations (local schema changes)
```

### Optional: pgvector

Migrations deliberately never require pgvector — the `embedding vector(1536)` column lives outside the Prisma schema. If your Postgres has the extension available (e.g. `apt install postgresql-16-pgvector`, or managed Postgres like Neon/Supabase/RDS), enable it once:

```bash
psql "$DATABASE_URL" -f prisma/sql/enable-pgvector.sql
```

This creates the extension, adds the `embedding` column to `EmbeddingChunk`, and builds an IVFFlat cosine index. The app detects the column at runtime — no config needed.

### Search fallback behavior

| pgvector | `OPENAI_API_KEY` | RAG search mode |
| --- | --- | --- |
| yes | set | `vector` — ANN similarity search in SQL |
| no | set | `hybrid` — keyword prefilter + cosine ranking in app code over JSON-stored embeddings |
| any | unset | `keyword` — Postgres full-text search (`websearch_to_tsquery`, AND→OR retry, ILIKE fallback) |

## Syncing data

### Full sync

```bash
npm run sync:crisp                 # everything, from page 1
npm run sync:crisp -- --page=42    # resume an interrupted run from page 42
```

Progress (last page reached, counts, failed sessions) is persisted to `SyncLog` after **every page**, so an interrupted run can be resumed with `--page=N` (check `pageTo` on the latest log, or the dashboard).

### wp.org forum watcher

```bash
npm run wporg:check                  # fetch new forum topics + draft suggestions
npm run wporg:check -- --no-suggest  # only fetch topics
```

Cron example (hourly): `0 * * * *  cd /path/to/app && npm run wporg:check`. Replies stay drafts for a human to copy and post — the tool never writes to wordpress.org.

**Age cutoff** — quiet forums keep years-old topics in their RSS feed, so each check skips any feed topic whose publish date is older than `WPORG_TOPIC_MAX_AGE_DAYS` (default 30) — those are never stored and never drafted (topics with no publish date are kept, since their age is unknown). The count of skipped-old topics is reported in the result and logs. A one-time migration (`…_delete_stale_support_threads`) also removes any pre-existing `SupportThread` rows older than 30 days (all statuses; NULL publish dates kept) when you `prisma migrate deploy`.

**Background checks + logs** — "Check forums now" on `/suggestions` runs in the background (like Crisp sync): `POST /api/wporg/check` returns `202` immediately and the run drives its own progress, so navigating away or opening another tab never loses visibility. The button shows live progress (`Checking 8/14 — FileBird…`, then `Drafting 2/5…`) for any in-flight check, and a one-line last-check summary (`Last check 4m ago — 3 new topics, 2 drafted, 1 skipped (old)`, with feed errors expandable) sits under the toolbar. Each run is recorded in the `ForumCheckLog` table (status, counts, errors); poll `GET /api/wporg/check/status` for live progress plus the 5 most recent runs.

### Incremental sync

```bash
npm run sync:crisp:incremental              # since the last successful run
npm run sync:crisp:incremental -- --page=N  # resume an interrupted run
```

Only syncs conversations updated since the last successful run, with a 1-hour overlap window to absorb clock skew. Falls back to a full sync when the database has never been synced. Designed for cron:

```cron
*/30 * * * *  cd /path/to/yayassist && npm run sync:crisp:incremental >> /var/log/yayassist-sync.log 2>&1
```

### From the dashboard

`/crisp/dashboard` has **Full sync**, **Incremental sync** and **Stop** buttons backed by `POST /api/sync/crisp/start` and `POST /api/sync/crisp/stop`, with live progress from `GET /api/sync/crisp/status`. Only one sync can run at a time (a second start returns `409`). Stop is graceful: the conversation in flight finishes, progress is persisted, and the log is marked `cancelled`.

### Reliability details

- **Rate limiting** — all Crisp requests are serialized through one process-wide queue with a minimum inter-request delay (`CRISP_REQUEST_INTERVAL_MS`, default 150 ms).
- **Backoff** — retryable failures (429/5xx/network) retry with exponential backoff (2s, 4s, 8s, ... capped at 60s), honouring `Retry-After` when present, up to `CRISP_MAX_RETRIES`.
- **Failed sessions** — a conversation that fails to sync is logged to `SyncLog.failedSessions` and the run continues. At the end of the run every failed session is **retried once**; if any still fail, the run is marked `failed` so the incremental checkpoint does not advance past them (they will be picked up again on the next run).
- **Single-flight guard** — besides the in-process lock, a sync refuses to start while a `SyncLog` row is still `running` (rows older than 6 h are treated as crashed). If a run was killed hard, mark its log row `failed` to unblock.
- **Single-conversation resync** — re-fetch one conversation (and rebuild its chunks) without a full run:

  ```bash
  curl -u admin:pass -X POST http://localhost:3000/api/sync/crisp/conversation/SESSION_ID
  ```

  Also available as a button on the conversation detail page.

Resolved conversations get their RAG chunks rebuilt automatically during sync.

## RAG

### How chunks are built (`src/lib/rag/chunker.ts`)

1. Messages are ordered chronologically; **notes and events are excluded** (private operator notes never reach chunks). Attachments become `[attachment: name]` placeholders.
2. Messages are grouped into **customer → operator exchanges**; whole exchanges are packed into chunks of up to ~1600 characters (~350–400 tokens).
3. Every chunk gets a **metadata header** — `[Session: ... | Date: ... | Product: ... | Tags: ... | Language: ...]` — so retrieved text is self-describing when pasted into an LLM prompt.
4. The chunk body is passed through **redaction** (`src/lib/rag/redact.ts`), which replaces:
   - email addresses → `[EMAIL]`
   - phone numbers (7+ digits, date-aware) → `[PHONE]`
   - card numbers (13–19 digits, Luhn-validated) → `[CARD_NUMBER]`
   - API keys/tokens (OpenAI `sk-`, GitHub, Slack, AWS, JWTs, long hex) → `[API_KEY]`
   - license keys and UUIDs → `[LICENSE_KEY]`
   - `password: ...` values → `[PASSWORD]`
5. **Product detection** (`src/lib/rag/products.ts`) tags each chunk with one of: FileBird, YayMail, YayCurrency, YaySMTP, Brandy, YayCommerce, WooCommerce, WordPress. Crisp tags win over text matches; specific plugins beat platform matches.

### Rebuilding chunks

```bash
npm run rag:rebuild                 # resolved conversations only, with embeddings
npm run rag:rebuild -- --all        # every conversation
npm run rag:rebuild -- --no-embed   # skip embedding generation
```

Or via `POST /api/rag/chunks/rebuild` (dashboard button) — background rebuild of all (resolved) conversations, or synchronous for a single `sessionId`.

**Staleness notice** — when plugin/keyword definitions change or a release bumps the chunk-building rules (`CHUNKER_VERSION` in `src/lib/rag/chunker.ts`), the existing chat chunks no longer match the current rules. `GET /api/rag/rebuild-advice` (backed by a small `AppMeta` key-value table) surfaces a "Rebuild recommended" banner on `/rag`, an amber dot on the RAG Search nav item, and a line in the dashboard Knowledge-coverage panel until a full rebuild is run. Regular syncs and docs/forum ingest chunk with the current rules, so they never trigger it.

### Testing search

Use the `/rag` page, or hit the API directly:

```bash
curl -u admin:pass "http://localhost:3000/api/rag/search?query=refund+not+working"
```

The response includes the `mode` actually used (`vector` / `hybrid` / `keyword`), and each result links back to its source conversation.

## API reference

All routes require Basic auth (see Security). All bodies/queries are Zod-validated.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/sync/crisp/start` | Start a background sync. Body `{mode?: "full"\|"incremental", startPage?}`. `202` on start, `409` if one is running |
| `GET` | `/api/sync/crisp/status` | Live sync progress + last completed run + 10 most recent logs |
| `POST` | `/api/sync/crisp/stop` | Request graceful cancellation of the running sync (`409` if none) |
| `POST` | `/api/sync/crisp/conversation/{sessionId}` | Re-fetch one conversation from Crisp, upsert it, rebuild its chunks |
| `GET` | `/api/conversations` | Paginated list. Query: `page, pageSize, state, tag, product, brandId, email, operatorId, hasAttachment, dateFrom, dateTo, search` |
| `GET` | `/api/conversations/{sessionId}` | Full conversation detail: messages, files, operator, chunk summaries |
| `GET` | `/api/rag/search` | RAG search. Query: `query` (required), `limit` (default 8, max 50), `source` (`crisp_chat`\|`plugin_docs`\|`wporg_forum`), `pluginId`, `brandId` |
| `POST` | `/api/rag/chunks/rebuild` | Rebuild chat chunks. Body `{sessionId?, onlyResolved?, withEmbeddings?}`. Single session is synchronous; full rebuild runs in the background (`202`, `409` if already running) |
| `GET`/`POST` | `/api/brands` | List brands / create a brand `{name, crispWebsiteId, domain?, wpProfileSlug?}` (adopts already-synced conversations with that website ID) |
| `PATCH`/`DELETE` | `/api/brands/{id}` | Update or delete a brand — including its Crisp token and `wpProfileSlug` (conversations are kept; plugins/docs cascade) |
| `POST` | `/api/brands/{id}/test` | Verify the brand's Crisp token can reach its website (page-1 probe) |
| `POST` | `/api/brands/{id}/import-plugins` | Bulk-create a Plugin (+ idle Forum Q&A source) for every plugin published by the brand's `wpProfileSlug` wp.org author; existing plugins (by wp.org slug or derived name) are skipped, nothing is ingested. `502` on wp.org API failure |
| `GET`/`POST` | `/api/plugins` | List plugins (with docs sources) / create `{brandId, name, wpOrgSlug?, detectionKeywords?}` |
| `PATCH`/`DELETE` | `/api/plugins/{id}` | Update or delete a plugin (docs pages + doc chunks cascade) |
| `POST` | `/api/docs/sources` | Register a docs source `{pluginId, url, type: "url"\|"sitemap"\|"wporg_forum"}` — wp.org forum URLs are auto-detected whatever type is sent |
| `GET`/`DELETE` | `/api/docs/sources/{id}` | Source status (for polling) / remove the source and its pages/chunks |
| `POST` | `/api/docs/sources/{id}/ingest` | Crawl + chunk + embed in the background (`202`, `409` while running). For `wporg_forum` sources this imports answered forum topics as Q&A transcripts |
| `POST` | `/api/wporg/check` | Start a background check of the wp.org forum feeds of all plugins with a `wpOrgSlug`; stores new topics (skipping ones older than `WPORG_TOPIC_MAX_AGE_DAYS`) and drafts suggestions. Body `{withSuggestions?, pluginId?}`. `202` with initial progress, `409` if one is running |
| `GET` | `/api/wporg/check/status` | Live forum-check progress + the 5 most recent `ForumCheckLog` runs (with errors) |
| `GET` | `/api/wporg/threads` | Support topics + suggestions. Query: `status, pluginId, page, pageSize` |
| `PATCH`/`DELETE` | `/api/wporg/threads/{id}` | Update review status (`reviewed`/`dismissed`/...) or delete |
| `POST` | `/api/wporg/threads/{id}/suggest` | (Re)generate the RAG-grounded reply draft for a topic |
| `POST` | `/api/suggest/test` | Draft reply suggestions for a hypothetical question **without** persisting a thread. Body `{pluginId, title?, content}` (content 10–5000 chars). `404` unknown plugin, `400` invalid body |
| `POST`/`GET` | `/api/wporg/suggest-missing` | Start a background bulk run drafting suggestions for every topic with no draft yet (`202`, `409` while running; body `{pluginId?}`) / poll its progress |

## Admin UI

| Page | What it shows |
| --- | --- |
| `/dashboard` | Global overview: open topics / drafts ready / reviewed, knowledge-chunk totals, latest forum topics, and the **Knowledge coverage** panel — per-source chunked/embedded accounting with failed-source and crawl-cap warnings plus the active search tier |
| `/crisp/dashboard` | Crisp tab: conversation/message/brand totals, sync controls with live progress, recent sync log table |
| `/crisp/conversations` | Crisp tab: filterable, paginated conversation list (state, tag, product, brand, operator, email, attachments, date range, search) |
| `/crisp/conversations/{sessionId}` | Chat-style message log with attachments, visitor panel (masked PII), resync/rebuild actions, chunk summaries |
| `/rag` | Search playground: query the chunk store (all sources / chats / docs / forum Q&A), see mode + similarity scores + source conversation, docs-page or forum-topic links |
| `/brands` | Manage brands — one per Crisp website; the sync covers every brand listed. Set a brand's wp.org author profile to bulk-import its plugins with one click |
| `/plugins` | Manage plugins per brand (detection keywords, wp.org slug), their docs sources and wp.org forum Q&A sources, with one-click ingest and live crawl status |
| `/suggestions` | wp.org forum topics with RAG-grounded reply drafts: filter by status/plugin, check forums on demand, bulk-generate missing drafts, regenerate/copy drafts, mark reviewed or dismissed |
| `/test-answer` | Answer-quality playground: paste a hypothetical support question and get the same RAG-grounded reply drafts the forum flow produces — no `SupportThread` is created, nothing is saved |

`/` redirects to `/dashboard`.

## Security notes

- **Basic auth everywhere** — `src/middleware.ts` protects every page and API route. In production, the app **refuses to serve** (`503`) if `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` are unset; in development it runs open with a console warning. Credential comparison is timing-safe.
- **Secrets stay server-side** — `src/env.ts` must only ever be imported from server code; Crisp/OpenAI credentials never reach the browser bundle. Client components use the API routes.
- **PII is masked in the UI** (emails, phones, IPs) and **redacted from RAG chunks** before embedding. The unmodified originals exist only in the database (`rawJson` columns).
- **Nothing is sent to third parties** except redacted chunk text to OpenAI for embeddings — and only when `OPENAI_API_KEY` is set.

## Adjusting Crisp endpoints

All Crisp REST API paths live in **one file**: `src/lib/crisp/endpoints.ts`. If a path differs from the [official docs](https://docs.crisp.chat/references/rest-api/v1/) or changes in the future, edit it there — nothing else in the codebase needs to move.

## Demo data

```bash
npm run seed:demo
```

Seeds five realistic **fake** conversations (FileBird, YayMail, YayCurrency, YaySMTP, pre-sales) through the real sync pipeline — normalization, upserts, file extraction, chunk building and redaction all run exactly as they would for live data. Idempotent: re-running replaces the previous demo rows. No Crisp API access required.

## Project structure

```
prisma/
  schema.prisma              # Conversation, Message, Operator, ConversationFile,
                             # EmbeddingChunk, SyncLog
  sql/enable-pgvector.sql    # optional pgvector column + IVFFlat index
scripts/
  sync-full.ts               # npm run sync:crisp [-- --page=N]
  sync-incremental.ts        # npm run sync:crisp:incremental (cron-friendly)
  rebuild-chunks.ts          # npm run rag:rebuild [-- --all --no-embed]
  seed-demo.ts               # npm run seed:demo
src/
  middleware.ts              # HTTP Basic auth for all pages + API
  env.ts                     # Zod-validated server-only environment
  app/
    dashboard/               # stats + sync controls
    conversations/           # list + [sessionId] detail
    rag/                     # search playground
    api/
      sync/crisp/            # start | status | stop | conversation/[sessionId]
      conversations/         # list | [sessionId] detail
      rag/                   # search | chunks/rebuild
  lib/
    crisp/                   # endpoints.ts (single endpoint map), client.ts
                             # (rate-limited, retrying API client), types.ts
    sync/                    # sync-service.ts (page loop), normalize.ts,
                             # sync-state.ts (in-process progress)
    rag/                     # chunker.ts, redact.ts, products.ts,
                             # embeddings.ts, rebuild.ts, search.ts
    conversations.ts         # list/detail/filter/stats queries
    db.ts                    # Prisma client singleton
  components/                # UI (shadcn-style primitives + feature components)
```
