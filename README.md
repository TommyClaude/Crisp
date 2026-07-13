# YayAssist

**AI answer suggestions for support teams.** YayAssist watches the wordpress.org support forums of your plugins and drafts replies for your supporters to review — grounded in what the AI has learned from your historical [Crisp.chat](https://crisp.chat) conversations and product documentation (RAG, no fine-tuning).

Crisp is a *data source* here, not the product: the tool syncs every support conversation from the Crisp REST API into your own Postgres database (browsable in a chat-log UI), crawls your docs sites into the same knowledge index, and uses both to suggest answers. Nothing is ever posted automatically — supporters review, copy, and post.

## Features

- **Sync engine** — full and incremental syncs of all conversations, messages, attachments and operators. Global rate limiting with exponential backoff, page-level resumability, graceful cancellation, per-run `SyncLog` history and failed-session tracking. Run from the CLI, cron, or dashboard buttons.
- **Crisp-like chat log UI** — paginated, filterable conversation list (state, tag, product, operator, email, attachments, date range, free-text search) and a message-by-message conversation view with attachments and visitor metadata.
- **3-tier RAG search** — pgvector ANN search when available, in-app cosine ranking over JSON-stored embeddings when not, and Postgres full-text keyword search when no OpenAI key is configured. The best available tier is picked automatically at query time.
- **PII redaction** — emails, phone numbers, card numbers (Luhn-validated), API keys/tokens, license keys/UUIDs and passwords are redacted from all embedding chunks before anything is vectorized. Raw data stays in the database only. PII shown in the UI is masked.
- **Junk detection** — automated noise (no-reply notification emails like "[WordPress Plugin] Review pending", never answered by an operator) is classified as junk automatically, transparently, and conservatively. A small heuristic classifier (`src/lib/crisp/junk.ts` — enumerated rules, no LLM) runs at sync and on demand via **Scan for junk** (`/crisp/conversations`), storing a human-readable `junkReason` (e.g. *automated sender*, *bracketed notification subject, never answered*) shown as a badge on every junk conversation. Junk is **excluded from the RAG index** the AI learns from — its chunks are deleted the moment it's flagged and never rebuilt. Nothing is deleted or hidden: junk stays fully browsable and is filterable (**All / Hide junk / Junk only**). A **human veto** always wins — mark or unmark any conversation by hand and the auto-classifier never overwrites that decision (`junkOverride`), even on a re-scan.
- **Product detection** — conversations are tagged with the plugin/product they are about using keyword heuristics where specific plugins beat platform-level matches. Detection definitions come from the plugins you manage in `/plugins` — the plugin name and its full wp.org slug both auto-match on their own (the slug catches pasted plugin URLs and `wp-content/plugins/...` error paths), plus any keywords you add; a built-in list (FileBird, YayMail, YayCurrency, YaySMTP, Brandy, YayCommerce, WooCommerce, WordPress) is the fallback for a fresh install. Each plugin's **AI suggest keywords** action (when an LLM provider is configured) reviews its current keywords against its wp.org listing + slug, recent support-thread titles, docs sources, and the top orphan Crisp segments (tags no plugin currently claims — the same data as the `/rag` panel), and proposes additions/removals for human review before anything is applied.
- **Multi-brand sync** — one `Brand` per Crisp website (e.g. YayCommerce, Ninja Team, CatFolders...), managed in `/brands`. The sync iterates every brand with a single plugin token; conversations are linked to their brand and filterable by it. A brand can also carry its wordpress.org author username (`wpProfileSlug`), enabling **one-click plugin import** — pull every plugin that author publishes on WordPress.org and create a Plugin (+ idle forum Q&A source) for each, skipping ones you already have.
- **wp.org forum watcher + answer suggester** — polls each plugin's WordPress.org support-forum feed (`wpOrgSlug`), stores new topics, retrieves the most relevant past conversations + docs via RAG, and (when an LLM provider is configured) drafts a reply for human review in `/suggestions`. Drafts are **never** posted automatically. Retrieval is **plugin-scoped first**, and when that is too thin it widens to the plugin's **own brand only** — never a cross-brand search — so a topic for one plugin is never grounded on a different brand's chats or docs. Provider-agnostic: with `SUGGESTER_PROVIDER=auto` (default) it drafts from **every** configured provider — set both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` and each "Regenerate drafts" produces an Anthropic *and* an OpenAI draft side by side to compare and pick from. Pin a single provider with `SUGGESTER_PROVIDER=anthropic|openai`. With no key configured the page still shows the retrieved grounding context.
- **Follow-up reply drafts** — the side-by-side drafts answer a topic's *first* post. Clicking **Regenerate** on a topic *additionally* fetches the whole live thread from wordpress.org and drafts the **next** reply the support team should post — grounded on the same RAG context but keyed on the newest customer message, and shown in a distinct amber box below the first-reply drafts (one card per provider, with Copy). This whole-thread pass runs **only** on the manual Regenerate action; the bulk "Generate missing drafts", the feed watcher, and every auto-draft path keep the cheaper first-reply-only behavior for cost control. Topics with no replies yet, or threads that can't be fetched, show a short note instead of drafts. A follow-up whose newest message *both* closes the old issue (thanks / resolved / review) *and* raises a new question is thanked in one line and then answered from context, without re-litigating the solved issue. When the **support team** posted last, the follow-up normally skips (the ball is with the customer) — but if the team owed an update, a **Draft anyway** button on that skip note drafts the reply that *delivers on the promise* (report the outcome/status and next step, don't close the thread).
- **"Needs reply" work queue + follow-up reminders** — `/suggestions` opens on a **Needs reply** tab: every topic still waiting on a human (no draft yet, a draft to review, or a failed draft) *plus* anything flagged for attention even after review — a fresh customer reply, or an overdue support follow-up promise (dismissed topics never appear). Flagged topics sort to the top. The remaining tabs are honest filters: **Recent** (browse-all, freshest activity first), **No draft** (topics with no draft yet — formerly the confusingly-named "New"), **Failed**, **Reviewed**, **Dismissed**. Each empty view now says something true for that tab (`All caught up — nothing is waiting on your team.`, `Every topic has a draft.`, …); the old "set a wp.org slug…" onboarding hint shows only when the database genuinely has no topics. **Follow-up due:** the problem is a supporter replying "let me check with the team and get back to you" and then forgetting. When the support team posts the last reply, the watcher classifies it with one tiny YES/NO LLM call; a YES stamps `SupportThread.followupPromisedAt`, and once that promise is older than `WPORG_PROMISE_REMINDER_DAYS` (default 3, a grace period) an amber **Follow-up due** badge appears on `/suggestions` and the dashboard and the topic is pulled into Needs reply. The promise clears when the team delivers (Regenerate drafts the delivering reply), the customer replies (that supersedes it), or the topic's status changes. **Waiting on customer & "Needs resolved":** when the team's newest reply made no promise, the topic leaves Needs reply entirely (`SupportThread.waitingSince`, muted "Waiting on customer" badge in Recent) — the ball is with the customer. After `WPORG_SILENCE_NUDGE_DAYS` (default 3) days of silence it surfaces in the **Needs resolved** tab (amber "No response · Nd" badge, longest wait first), but only while the topic is still un-resolved on wordpress.org (`wpResolved`, parsed from the topic page and re-checked each forum run for up to 20 waiting topics, oldest first, skipping ones already touched within the last hour — a topic marked Resolved on the forum drops out on its own). Regenerate there drafts a gentle **closing reply** (thanks, no word back, hope it's resolved, may we close, reopen anytime). A fresh customer reply at any point returns the topic to Needs reply; reviewing/dismissing ends the wait.
- **Per-brand reply style + voice mimicry** — each brand can carry free-text house-style notes (`Brand.replyStyle`, edited inline on `/brands`): sign-off, tone, emoji policy, favourite phrasings. When set, they are appended as a clearly delimited section to *both* drafting prompts (first-reply and follow-up) and to the `/test-answer` playground, so drafts sound like the team. Style is guidance layered on top of — never overriding — the grounding/correctness rules: it shapes wording only and can't license invented facts or links. On top of any explicit style, both prompts instruct the model to **mimic the support team's own voice** as it appears in the retrieved examples (the operator turns in past Crisp conversations and the support-team replies in answered wp.org topics) and, for follow-ups, the team's replies already in the thread — matching greeting, sign-off, emoji and phrasing while copying only tone/format, never customer-specific details. A "don't sound like an AI" ruleset (no em/en dashes, no reflex openers/closers, no formulaic lists, varied sentence length) keeps drafts reading like a real forum poster; an explicit `replyStyle` wins over inferred voice when both apply.
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

## Deploying

The steps above are for local development. To put this in front of your support team over the internet, see **[docs/DEPLOY.md](docs/DEPLOY.md)** — a Docker Compose kit with two paths: a VPS with a domain (Caddy auto-HTTPS) or a Mac mini/home box behind a Cloudflare Tunnel (no public IP needed). Also covers migrating your existing dev database (pgvector embeddings preserved byte-for-byte), backups, and updates.

## Crisp API token (one, global)

Each brand is a separate Crisp **website**, and a plain Crisp REST API token only reaches the website that created it. YayAssist instead uses a **production token from an approved Crisp Marketplace plugin**, which reaches every workspace the plugin is installed on — so a single `CRISP_IDENTIFIER`/`CRISP_KEY` pair in `.env` covers every brand.

To bring a brand's website into scope:

1. Install the YayAssist Marketplace plugin on that Crisp workspace.
2. Set `CRISP_IDENTIFIER`/`CRISP_KEY` in `.env` to the plugin's production token (once, not per brand).
3. Find the **website ID** in the Crisp app URL (`app.crisp.chat/website/<website_id>/...`) — enter it as the brand's Crisp website ID when adding it in `/brands`.
4. Click **Test** on the brand row to confirm the token reaches that website.

> `CRISP_WEBSITE_ID` remains as a legacy single-website fallback, only used when no brands exist yet.

## Environment variables

Copy `.env.example` to `.env`. Validated at startup by `src/env.ts` (Zod) — invalid config fails fast with a readable error.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CRISP_WEBSITE_ID` | no (legacy) | — | Single-website fallback, used only when no brands exist yet. Prefer adding brands (one per Crisp website) in `/brands` |
| `CRISP_IDENTIFIER` | no | — | Crisp Marketplace plugin production token identifier, shared by every brand (see above) |
| `CRISP_KEY` | no | — | Crisp Marketplace plugin production token key, shared by every brand |
| `DATABASE_URL` | yes | — | Postgres connection URL |
| `OPENAI_API_KEY` | no | empty | Enables embedding generation for vector/hybrid RAG search. Unset → keyword search only |
| `OPENAI_EMBEDDING_MODEL` | no | `text-embedding-3-small` | Embedding model (1536 dimensions) |
| `SUGGESTER_PROVIDER` | no | `auto` | LLM for forum-reply drafts: `auto` \| `anthropic` \| `openai` |
| `ANTHROPIC_API_KEY` | no | — | Enables Anthropic drafts (`auto` prefers it when set) |
| `ANTHROPIC_MODEL` | no | `claude-opus-4-8` | Anthropic model for drafts |
| `OPENAI_CHAT_MODEL` | no | `gpt-4o-mini` | OpenAI model for drafts (uses `OPENAI_API_KEY`) |
| `WPORG_FEED_BASE` | no | `https://wordpress.org/support/plugin` | Forum feed base URL (tests only) |
| `WPORG_MAIL_ENABLED` | no | `false` | Enable the wp.org email-push listener (near-realtime forum updates). Requires `WPORG_MAIL_USER` + `WPORG_MAIL_PASSWORD` |
| `WPORG_MAIL_HOST` | no | `imap.gmail.com` | IMAP host for the notification inbox |
| `WPORG_MAIL_PORT` | no | `993` | IMAP port (implicit TLS) |
| `WPORG_MAIL_USER` | no | — | IMAP username (the dedicated inbox address) |
| `WPORG_MAIL_PASSWORD` | no | — | IMAP password — for Gmail, a 16-char App Password (needs 2FA) |
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

Progress (last page reached, counts, failed sessions) is persisted to `SyncLog` after **every page**, so an interrupted run can be resumed with `--page=N` (check `pageTo` on the latest log, or the dashboard). The CLI's `--page=N` is the legacy single-number resume — it only ever applies to the *first* configured brand (createdAt order), same as before; the per-brand resume described below (each brand's own furthest page, applied automatically) is a dashboard-only feature (`resume: true` on `POST /api/sync/crisp/start`).

### wp.org forum watcher

```bash
npm run wporg:check                  # fetch new forum topics + draft suggestions
npm run wporg:check -- --no-suggest  # only fetch topics
```

Cron example (hourly): `0 * * * *  cd /path/to/app && npm run wporg:check`. Replies stay drafts for a human to copy and post — the tool never writes to wordpress.org.

**Age cutoff** — quiet forums keep years-old topics in their RSS feed, so each check skips any feed topic whose publish date is older than `WPORG_TOPIC_MAX_AGE_DAYS` (default 30) — those are never stored and never drafted (topics with no publish date are kept, since their age is unknown). The count of skipped-old topics is reported in the result and logs. A one-time migration (`…_delete_stale_support_threads`) also removes any pre-existing `SupportThread` rows older than 30 days (all statuses; NULL publish dates kept) when you `prisma migrate deploy`.

**Background checks + logs** — "Check forums now" on `/suggestions` runs in the background (like Crisp sync): `POST /api/wporg/check` returns `202` immediately and the run drives its own progress, so navigating away or opening another tab never loses visibility. The button shows live progress (`Checking 8/14 — FileBird…`, then `Drafting 2/5…`) for any in-flight check, and a one-line last-check summary (`Last check 4m ago — 3 new topics, 2 drafted, 1 skipped (old)`, with feed errors expandable) sits under the toolbar. Each run is recorded in the `ForumCheckLog` table (status, counts, errors); poll `GET /api/wporg/check/status` for live progress plus the 5 most recent runs.

### Near-realtime updates via email push

wordpress.org has no webhooks, but it emails a subscribed account on every new topic and reply. An optional IMAP listener watches a dedicated inbox and, within seconds of a notification, runs a targeted single-topic check for exactly that topic — so updates land in near-realtime and the `wporg:check` cron can be relaxed (e.g. from hourly to a few times a day). **The scheduled forum check remains the safety net** for anything email push misses (a notification that never arrives, a listener outage, a topic whose plugin can't be resolved).

The listener starts automatically from Next's `instrumentation.ts` when configured; there is nothing to run separately.

**Setup:**

1. **Dedicated inbox** — create a mailbox that receives only these notifications (the owner uses `yayassist@gmail.com`). For Gmail, enable IMAP and create a 16-character **App Password** (requires 2-factor auth); use that, not the account password.
2. **Subscribe on wp.org** — for each plugin's support forum, click **Subscribe** while logged in as an account whose notification emails are forwarded to the dedicated inbox (in Gmail, set up a filter/forward from your wp.org account to `yayassist@gmail.com`). wp.org then emails that account on every new topic/reply.
3. **Configure** — set `WPORG_MAIL_ENABLED=true`, `WPORG_MAIL_USER`, `WPORG_MAIL_PASSWORD` (host/port default to Gmail). The listener refuses to start unless all three are present. Changing these values requires a server restart to take effect.

**Read-only guarantee** — the inbox is opened strictly `{ readOnly: true }`: the listener never marks messages seen, never moves or deletes them. Progress is tracked purely by message **UID** in the `wporg_mail_cursor` `AppMeta` row (never by `\Seen` flags), so the mailbox is left byte-for-byte untouched. Only mail whose envelope `From` address ends in `@wordpress.org` is acted on; everything else just advances the cursor. The single-topic check uses the same code path as the feed's resurface pass but never advances the feed dedupe watermark (it has no exact date). A brand-new customer topic ingested this way (the ball is with the team) is auto-drafted immediately — the same cheap first-reply-only pass the feed watcher uses for its newly found topics, never the expensive whole-thread follow-up pass. A reply on an already-tracked topic, or a support-last topic the mail path merely tracks into its waiting state, still leaves drafting to the manual **Regenerate** action.

A muted status line on `/suggestions` shows the listener's health (`Mail listener: listening · N events · M drafted` / `disabled` / `error: …`).

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

`/crisp/dashboard` has **Full sync**, **Incremental sync** and **Stop** buttons backed by `POST /api/sync/crisp/start` and `POST /api/sync/crisp/stop`, with live progress from `GET /api/sync/crisp/status`. Only one sync runs at a time — but see **Sync queue** below for what a second request does now instead of just erroring. Stop is graceful: the conversation in flight finishes, progress is persisted, and the log is marked `cancelled`.

### Per-brand resume

Every brand's Crisp website pages its conversation list independently, so "the furthest page reached" is really *one number per brand*, not one global number. `SyncLog.brandPages` (`{[brandId]: {from, to}}`) tracks this per run, updated at the same per-page cadence as the legacy `pageTo` column. When a full/incremental run is interrupted, the dashboard's **Continue** button posts `{mode: "full", resume: true}` — the server derives each configured brand's own furthest page from all of `SyncLog` history (`getResumePages`/`computeResumePages` in `src/lib/sync/sync-service.ts`) and resumes every brand from there automatically, with no page number required. The visible page-number input is kept as a **manual override**, exactly as the owner asked for ("tôi sẽ chủ động điền số trang muốn bắt đầu sync") — it prefills with the selected brand's resume page (`?brand=` in the URL) or, with no brand selected, the first brand's, and is only sent (as `startPage` + `startPageBrandId`, scoping the override to that one brand) when you actually edit it; an untouched prefill is not a "manual" value. `resume` and `startPage` can be combined — the explicit override merges on top of the derived per-brand map, so you can resume everything automatically except for the one brand you want to redirect. Legacy rows written before `brandPages` existed have no per-brand data and fall back to the old first-brand-only accounting for that one run (see **Full sync** below for the CLI's own legacy-only `--page=N`).

### Sync queue

Clicking Full sync, Incremental sync, or Sync range while one is already running no longer just 409s — the request is validated exactly as usual (still `400` if it's invalid) and, once valid, joins an in-memory FIFO queue instead: `POST /api/sync/crisp/start` returns `202 {queued: true, position, entry, progress}`. The queue holds up to **5** entries; a 6th distinct request `409`s "queue full", and re-submitting a request that exactly matches one already queued (same kind + `startPage`/`startPageBrandId`/`resume`/`dateStart`/`dateEnd`/`brandId`) `409`s "already queued" — but duplicating the *currently running* sync is fine to queue, since re-running the same thing is sometimes intentional. A queued `resume` entry re-derives its per-brand map when it's actually drained, not when it was queued, so it reflects everything synced while it waited.

When the running sync ends **naturally** (`completed` or `failed`), the next queued entry starts automatically, in order — including past a failure: if a queued run's target brand was deleted while it waited, that run fails and records its own `failed` `SyncLog` (same as any other failed run) and the queue keeps draining past it, so one stale entry can never wedge the rest. When the running sync is halted by the owner instead (**Stop** → `cancelled`, **Pause** → `paused`), the queue is **held** — nothing auto-starts, since Stop/Pause means "I want control now" and silently launching more work would fight that. A held queue shows an amber notice and a **Start next** button (`POST /api/sync/crisp/queue/start-next`) that clears the hold and starts one entry; the rest resume auto-advancing normally once that entry settles. Note that starting **any** sync manually while the queue is held clears the hold too — that run takes the slot now, and once it settles naturally the remaining queued entries resume auto-draining without another click. If you halted specifically to reconsider the backlog, remove the entries you no longer want before starting anything new. Each queued entry also has its own **✕** remove button (`POST /api/sync/crisp/queue/remove`).

The queue is **process memory only**, exactly like live sync progress — a server restart loses it, and it's local to one server process. There is no way to persist or re-queue it across a restart.

### Archive coverage & range sync

The **Archive coverage** section on `/crisp/dashboard` is a year × month heatmap of the conversations already in the database, bucketed by **last activity** (the `COVERAGE_BASIS` constant in `src/lib/sync/coverage.ts`). A **brand selector** (`?brand=<id>` in the URL) scopes the whole page — stats, coverage, and the range-sync default — to one brand at a time. With one brand selected you get its one grid; with "All brands" you get one **compact grid per brand, stacked vertically**, each with its own total — never a single grid merged across brands, since a filled month for one brand would otherwise hide another brand's gap. Clicking a month prefills the **From / To** date inputs (and, in "All brands" mode, remembers which brand's grid you clicked); **Sync range** then walks the Crisp list with `filter_date_start`/`filter_date_end` for that brand (or every brand, if none is scoped), so requests are proportional to the window, not the whole archive (runs land in `SyncLog` as kind `range`, with `brandId` set when scoped).

**Grid span** — each grid runs from its brand's earliest known month through the current month, not just the years already synced: the query pulls `MIN(createdAtCrisp)`/`MIN(updatedAtCrisp)` (scoped to that brand) for a zero-request lower bound (an old conversation that got recently bumped already stretches the grid back "for free"), combined with that brand's entry in any stored **Detect archive start** result (below). Months before that start or after the current month render dashed ("outside the archive"); months inside the span with zero conversations render as the plain empty cell — that's the actual gap the heatmap exists to reveal. The start is clamped to at most 15 years back as a guard against a pathological timestamp blowing up the grid. A brand with zero conversations and no detected start renders a one-line empty state instead of a grid.

**Detect archive start** — the DB-only lower bound only reaches as far as whatever's already synced. A small control spends ~10 tiny Crisp requests per brand (binary search by month, page-1 existence probes) to find each brand's true first conversation, even one never synced locally, and stores the per-brand result in `AppMeta` (`crisp_archive_start`) so it only has to run once — it always probes every configured brand in one go, so there's a single control for it (under the single/merged grid, or once below the "All brands" stack) rather than one per compact card. It also runs **automatically** at the start of every **full** sync (resumed ones included), for whichever brands don't have a stored result yet — brands already detected cost zero requests, and a brand with no conversations at all is remembered as such so it isn't re-probed every sync (a brand added later gets filled in on its next full sync) — the button remains as a manual trigger/retry and never blocks or fails the sync it might be piggybacking on.

Two safeguards on the range walk itself, because Crisp's docs don't spell out which timestamp the filter matches:

- **Early stop** — if an entire page comes back with zero conversations in-range by the basis (and at least one provably out of range), the walk stops instead of degenerating into an unbounded full walk.
- **First-run verification line** — each range run reports how many fetched conversations fell inside the window by *last activity* vs by *created date* ("In range by last-activity: X/N, by created: Y/N"). If created wins on your workspace, flip `COVERAGE_BASIS` once and the heatmap, the range guard, and the labels all follow.

Range syncs are idempotent upserts — re-running a window never duplicates data. Full and incremental syncs are never brand-scoped — they always walk every configured brand — but unlike a range sync, they resume **per brand**: Continue (`resume: true`) restarts every brand from its own furthest page automatically (see **Per-brand resume** above), and a manual page-number override targets just one brand (`startPageBrandId`) rather than clobbering every brand's progress with a single number (see the effective-start-pages resolution in `runSync`, `src/lib/sync/sync-service.ts`).

### Reliability details

- **Rate limiting** — all Crisp requests are serialized through one process-wide queue with a minimum inter-request delay (`CRISP_REQUEST_INTERVAL_MS`, default 150 ms).
- **Backoff** — retryable failures (429/5xx/network) retry with exponential backoff (2s, 4s, 8s, ... capped at 60s), honouring `Retry-After` when present, up to `CRISP_MAX_RETRIES`.
- **Failed sessions** — a conversation that fails to sync is logged to `SyncLog.failedSessions` and the run continues. At the end of the run every failed session is **retried once**; if any still fail, the run is marked `failed` so the incremental checkpoint does not advance past them (they will be picked up again on the next run).
- **Single-flight guard + restart self-healing** — besides the in-process lock, a sync refuses to start while a `SyncLog` row is still `running`. A server restart mid-run used to orphan that row as a phantom "Running" forever (blocking new syncs for hours); now any `running` row older than 10 minutes with no live run in the process is automatically closed as `failed` ("Interrupted: the server restarted…") on the next dashboard poll or start attempt — everything synced before the restart is already saved, so Continue or a range sync picks up where it left off. Forum-check history rows heal the same way. Caveat: a genuinely-running CLI backfill in another process older than that window gets its row closed early too; the CLI run itself is unaffected and rewrites its real status when it finishes.
- **Single-conversation resync** — re-fetch one conversation (and rebuild its chunks) without a full run:

  ```bash
  curl -u admin:pass -X POST http://localhost:3000/api/sync/crisp/conversation/SESSION_ID
  ```

  Also available as a button on the conversation detail page.

Resolved conversations get their RAG chunks rebuilt automatically during sync.

## RAG

### How chunks are built (`src/lib/rag/chunker.ts`)

0. **Junk conversations are excluded** — a conversation flagged junk (`isJunk`, set by the classifier in `src/lib/crisp/junk.ts` at sync / scan, or by a manual mark) is never chunked; any chunks it still holds are deleted, so automated noise never enters the index the AI learns from.
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
5. **Product detection** (`src/lib/rag/products.ts`) tags each chunk with one of: FileBird, YayMail, YayCurrency, YaySMTP, Brandy, YayCommerce, WooCommerce, WordPress. Crisp segments (tags) win over text matches; specific plugins beat platform matches. The detected product is also resolved to the backing **`pluginId`** (by definition identity, so no per-chunk name lookup) and stored on the chunk, so plugin- and brand-scoped retrieval reaches chat chunks too. A product that maps to no plugin — a built-in platform (WooCommerce/WordPress) or a segment with no plugin — keeps its product string but a NULL `pluginId`. Segments that match no plugin at all surface in the **Orphan segments** card on `/rag` so you know which ones need a plugin or keyword.

### Rebuilding chunks

```bash
npm run rag:rebuild                 # resolved conversations only, with embeddings
npm run rag:rebuild -- --all        # every conversation
npm run rag:rebuild -- --no-embed   # skip embedding generation
```

Or via `POST /api/rag/chunks/rebuild` (dashboard button) — background rebuild of all (resolved) conversations, or synchronous for a single `sessionId`.

**Embedding reuse** — a rebuild snapshots each conversation's existing chunk embeddings (keyed by chunk text) before rewriting them, and reuses the embedding of any chunk whose text is byte-identical instead of re-calling the OpenAI API. Only genuinely new or changed text is embedded, so a full rebuild after a `CHUNKER_VERSION` bump (e.g. to backfill `pluginId`) costs almost nothing when the chunk text itself didn't change. The rebuild reports the split ("embedded X, reused Y"). Reuse is best-effort: any snapshot failure falls back to normal embedding, and a reused vector is only ever written for identical text, so it can't produce a mismatched embedding.

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
| `POST` | `/api/sync/crisp/start` | Start a background sync. Body `{mode?: "full"\|"incremental", startPage?, startPageBrandId?, resume?, dateStart?, dateEnd?, brandId?}` — `dateStart`+`dateEnd` (both, `YYYY-MM-DD`, start ≤ end) run a range sync over that window; `startPage`/`startPageBrandId`/`resume` are for full/incremental only and are each rejected alongside a date range (range page numbers index Crisp's filtered list, not the archive); `brandId` scopes a range sync to one Brand and is rejected without a date range (full/incremental always cover every brand). `resume: true` derives each brand's own starting page from its furthest page across history (see **Per-brand resume**) with no numbers from the client; `startPage` alone keeps its legacy meaning (resumes the first configured brand only); `startPageBrandId` scopes `startPage` to one brand instead and requires `startPage` + an existing Brand id (`400` otherwise); `resume` + `startPage` combine, with the override merging onto the derived map. All validation happens before checking whether a sync is running, so an invalid body always `400`s. `202 {started: true, ...}` when it starts immediately; `202 {queued: true, position, entry, progress}` when one is already running and this joins the FIFO queue instead (see **Sync queue** — a queued `resume` entry re-derives its map at drain time); `409` if queuing itself fails (duplicate of an already-queued entry, or the queue is full) |
| `GET` | `/api/sync/crisp/status` | Live sync progress (now including `queue` — the FIFO array — and `held`) + last completed run + 10 most recent logs + `resumePage` (legacy single number) and `resumePages` (per-brand map, see **Per-brand resume**) |
| `POST` | `/api/sync/crisp/stop` | Request graceful cancellation of the running sync (`409` if none). Also HOLDS the queue — see **Sync queue** |
| `POST` | `/api/sync/crisp/queue/remove` | Remove one entry from the sync queue. Body `{id}`. `404` if that id isn't currently queued |
| `POST` | `/api/sync/crisp/queue/start-next` | Clear a held queue and start its next entry. `409` if a sync is already running or the queue is empty |
| `POST` | `/api/sync/crisp/conversation/{sessionId}` | Re-fetch one conversation from Crisp, upsert it, rebuild its chunks |
| `POST` | `/api/sync/crisp/detect-start` | Binary-search each configured brand's true first-conversation month (~10 Crisp requests per brand) and store the per-brand result in `AppMeta`, merged with any existing entries. Also runs automatically on every full sync for brands missing an entry. `502` if a probe fails or no conversations are found anywhere |
| `POST` | `/api/crisp/junk/scan` | Re-classify every conversation without a manual override against the current junk rules (`src/lib/crisp/junk.ts`), batched and memory-flat, and purge the RAG chunks of any that newly became junk. Returns `{scanned, junk, byReason, cleaned}` (`cleaned` = chunks deleted). `409` while a sync is running |
| `GET` | `/api/conversations` | Paginated list. Query: `page, pageSize, state, tag, product, brandId, email, operatorId, hasAttachment, dateFrom, dateTo, search, preview, junk` — `preview` matches the last-message preview as an exact case-insensitive substring (no word-splitting, unlike `search`); handy for isolating automated junk threads like `[WordPress Plugin] …`. `junk` = `hide` (exclude junk) \| `only` (junk only); unset shows everything |
| `GET` | `/api/conversations/{sessionId}` | Full conversation detail: messages, files, operator, chunk summaries |
| `PATCH` | `/api/conversations/{sessionId}` | Human veto over junk classification. Body `{junk: boolean}` — sets `isJunk`, a `marked manually` reason (or null), and `junkOverride=true` so no sync/scan ever overwrites it. Marking junk ON deletes the conversation's RAG chunks (returned as `cleaned`); marking OFF does not auto-rebuild (the next rebuild/sync pass re-chunks it) |
| `GET` | `/api/rag/search` | RAG search. Query: `query` (required), `limit` (default 8, max 50), `source` (`crisp_chat`\|`plugin_docs`\|`wporg_forum`), `pluginId`, `brandId` |
| `POST` | `/api/rag/chunks/rebuild` | Rebuild chat chunks. Body `{sessionId?, onlyResolved?, withEmbeddings?}`. Single session is synchronous; full rebuild runs in the background (`202`, `409` if already running) |
| `GET`/`POST` | `/api/brands` | List brands / create a brand `{name, crispWebsiteId, wpProfileSlug?}` (adopts already-synced conversations with that website ID) |
| `PATCH`/`DELETE` | `/api/brands/{id}` | Update or delete a brand — name, `crispWebsiteId`, `wpProfileSlug` (conversations are kept; plugins/docs cascade) |
| `POST` | `/api/brands/{id}/test` | Verify the global Crisp token can reach the brand's website (page-1 probe) |
| `POST` | `/api/brands/{id}/import-plugins` | Bulk-create a Plugin (+ idle Forum Q&A source) for every plugin published by the brand's `wpProfileSlug` wp.org author; existing plugins (by wp.org slug or derived name) are skipped, nothing is ingested. `502` on wp.org API failure |
| `GET`/`POST` | `/api/plugins` | List plugins (with docs sources) / create `{brandId, name, wpOrgSlug?, detectionKeywords?}` |
| `PATCH`/`DELETE` | `/api/plugins/{id}` | Update or delete a plugin (docs pages + doc chunks cascade) |
| `POST` | `/api/plugins/{id}/suggest-keywords` | AI review of a plugin's detection keywords, grounded best-effort in its wp.org listing + slug, recent support-thread titles, docs sources, and the top orphan Crisp segments (unclaimed tags the AI may propose a keyword to claim). Never mutates the plugin — returns `{suggestion: {add, remove, keep}, grounding}` for human review; apply via the existing `PATCH`. `503` no LLM provider configured, `502` the model never returned valid JSON (one retry attempted) |
| `POST` | `/api/docs/sources` | Register a docs source `{pluginId, url, type: "url"\|"sitemap"\|"wporg_forum"}` — wp.org forum URLs are auto-detected whatever type is sent |
| `GET`/`DELETE` | `/api/docs/sources/{id}` | Source status (for polling) / remove the source and its pages/chunks |
| `POST` | `/api/docs/sources/{id}/ingest` | Crawl + chunk + embed in the background (`202`, `409` while running). For `wporg_forum` sources this imports answered forum topics as Q&A transcripts |
| `POST` | `/api/wporg/check` | Start a background check of the wp.org forum feeds of all plugins with a `wpOrgSlug`; stores new topics (skipping ones older than `WPORG_TOPIC_MAX_AGE_DAYS`) and drafts suggestions. Body `{withSuggestions?, pluginId?}`. `202` with initial progress, `409` if one is running |
| `GET` | `/api/wporg/check/status` | Live forum-check progress + the 5 most recent `ForumCheckLog` runs (with errors) |
| `GET` | `/api/wporg/mail/status` | Email-push listener state (`status`, `lastError`, `lastEventAt`, `eventsProcessed`, `drafted`, `connectedAt`) + the persisted UID cursor |
| `POST` | `/api/wporg/mail/restart` | Tear down + reconnect the listener's IMAP connection (recovers a wedged connection). Reuses loaded env — changing `WPORG_MAIL_*` still needs a server restart. `409` when disabled |
| `GET` | `/api/wporg/threads` | Support topics + suggestions. Query: `status, pluginId, page, pageSize` |
| `PATCH`/`DELETE` | `/api/wporg/threads/{id}` | Update review status (`reviewed`/`dismissed`/...) or delete |
| `POST` | `/api/wporg/threads/{id}/suggest` | (Re)generate the RAG-grounded reply draft for a topic |
| `POST` | `/api/suggest/test` | Draft reply suggestions for a hypothetical question **without** persisting a thread. Body `{pluginId, title?, content}` (content 10–5000 chars). `404` unknown plugin, `400` invalid body |
| `POST`/`GET` | `/api/wporg/suggest-missing` | Start a background bulk run drafting suggestions for every topic with no draft yet (`202`, `409` while running; body `{pluginId?}`) / poll its progress |

## Admin UI

| Page | What it shows |
| --- | --- |
| `/dashboard` | Global overview: open topics / drafts ready / reviewed, knowledge-chunk totals, latest forum topics, a **Mail listener** health card (status, connected/last-activity/last-notification timings, Restart) for the wp.org email-push feature, and the **Knowledge coverage** panel — per-source chunked/embedded accounting with failed-source and crawl-cap warnings plus the active search tier |
| `/crisp/dashboard` | Crisp tab: conversation/message/brand totals, sync controls with live progress, recent sync log table |
| `/crisp/conversations` | Crisp tab: filterable, paginated conversation list (state, tag, product, brand, operator, email, attachments, date range, search, **junk**), with junk badges and a **Scan for junk** control |
| `/crisp/conversations/{sessionId}` | Chat-style message log with attachments, visitor panel (masked PII), resync/rebuild actions, chunk summaries, and a **Mark as junk / Not junk** veto with a junk badge |
| `/rag` | Search playground: query the chunk store (all sources / chats / docs / forum Q&A), see mode + similarity scores + source conversation, docs-page or forum-topic links |
| `/brands` | Manage brands — one per Crisp website; the sync covers every brand listed. Set a brand's wp.org author profile to bulk-import its plugins with one click |
| `/plugins` | Manage plugins per brand (detection keywords, wp.org slug), their docs sources and wp.org forum Q&A sources, with one-click ingest and live crawl status. The add-plugin form sits behind an **Add a plugin** button, detection keywords are editable inline on each card — including a **Sparkles "AI suggest keywords"** action that grounds a single LLM call in the plugin's wp.org listing + slug, recent support threads, docs sources and the top orphan Crisp segments, then shows the proposed additions/removals (checkboxes, additions checked by default) in a dialog for human review before applying — and the list filters by brand and by status (missing docs / missing forum Q&A / never ingested). The **Add source** field has no type dropdown — the type (Crawl / Sitemap / wp.org forum Q&A) is auto-detected from the URL as you type and shown as a badge next to the input; click the badge to override it for that one submission |
| `/suggestions` | wp.org forum topics with RAG-grounded reply drafts. Opens on the **Needs reply** work queue (unhandled or flagged topics, flagged-first); tabs for Needs resolved / Recent / No draft / Failed / Reviewed / Dismissed, each showing a topic count. Shows **New reply** and **Follow-up due** badges, checks forums on demand, bulk-generates missing drafts, regenerates/copies drafts, marks reviewed or dismissed, and offers **Draft anyway** to deliver an overdue support promise |
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
      sync/crisp/            # start | status | stop | queue/remove | queue/start-next
                             # | conversation/[sessionId]
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
