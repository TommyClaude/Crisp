import { prisma } from "@/lib/db";
import { getEnv } from "@/env";
import { notifySlackTopic, slackConfigured } from "@/lib/notify/slack";
import { classifyFollowupPromise } from "@/lib/suggest/promise";
import { generateSuggestionForThread } from "@/lib/suggest/suggester";
import {
  canonicalForumUrl,
  fetchTopicThread,
  type FetchedTopicThread,
} from "@/lib/wporg/forum-crawler";
import { canonicalizeTopicUrl, topicSlug } from "@/lib/wporg/topic-url";
import type { Prisma } from "@prisma/client";
import {
  beginCheckProgress,
  endCheckProgress,
  getCheckProgress,
  isCheckRunning,
  type CheckHaltReason,
  type CheckProgress,
} from "./check-state";
import { fetchForumFeed, type ForumReply } from "./feed";

/**
 * WordPress.org forum watcher: polls the support-forum feed of every plugin
 * that has a wpOrgSlug, stores new topics as SupportThread rows, and
 * (optionally) drafts reply suggestions for them. Designed to run from cron
 * (`npm run wporg:check`) or the /suggestions UI.
 *
 * Plugins are processed in a deterministic alphabetical order (name asc); that
 * order defines each plugin's stable 1-based index for pause/continue. Each run
 * records live progress in the check-state globalThis singleton and a durable
 * ForumCheckLog row (created "running", updated to completed/paused/cancelled/
 * failed). The UI polls GET /api/wporg/check/status for both.
 */

export interface WatcherResult {
  pluginsChecked: number;
  newThreads: number;
  drafted: number;
  /** Feed topics skipped for being older than WPORG_TOPIC_MAX_AGE_DAYS. */
  skippedOld: number;
  /**
   * Old topics resurfaced by a fresh customer reply: an existing thread
   * flagged, or a thread created for a customer-last old topic.
   */
  resurfaced: number;
  /**
   * New-topic rows created this run whose fetch-before-create page check
   * found them NOT actionable — already resolved on wp.org, or support
   * answered last. Counted separately from `newThreads` (which counts every
   * row created, actionable or not): these rows are stored with correct
   * flags but deliberately never drafted or Slack-notified. Not persisted to
   * ForumCheckLog (no schema column — see the check-status live progress /
   * server logs instead).
   */
  skippedHandled: number;
  /** Terminal status of the run. */
  status: "completed" | "paused" | "cancelled" | "failed";
  /** Highest 1-based plugin index fully processed (the resume point). */
  lastIndex: number | null;
  errors: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Politeness delay between separate live-thread fetches (mirrors the
 *  between-plugins feed delay). */
const FEED_POLITENESS_MS = 500;

/**
 * Cap on the excerpt stored for a resurfaced topic's ORIGINAL first post —
 * mirrors MAX_EXCERPT_CHARS in feed.ts (kept in sync by hand; not exported
 * there to avoid coupling the crawler to the feed reader).
 */
const RESURFACE_EXCERPT_CHARS = 4000;

/**
 * Max silent topics re-checked per run by the resolution-refresh pass. A
 * wp.org "mark as resolved" action emits no feed item, so a topic sitting in
 * "Needs resolved" would never notice it got resolved (or that the customer
 * finally replied) — this pass polls a bounded batch of the oldest waiters.
 */
const SILENT_REFRESH_CAP = 20;

/** Deadband for the waitingSince retro-correction in {@link refreshSilentTopics}:
 *  a page-parsed date within an hour of the stored value isn't worth writing. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * OR-terms matching every stored spelling of one topic, for SupportThread row
 * lookups. New rows are stored under the canonical permalink
 * ({@link canonicalizeTopicUrl}), but rows written before canonicalization —
 * or by a feed that spells the guid differently (scheme/www/trailing slash,
 * /page/N/ suffix) — must still match, or the feed and mail paths would fork
 * one topic into two rows. Matches the canonical string, any raw spellings the
 * caller has in hand, and a slug-anchored form for everything else. The slug
 * terms are boundary-safe: `contains ".../<slug>/"` (trailing slash bounds the
 * slug) plus `endsWith ".../<slug>"` — so "my-topic" never matches
 * "my-topic-2".
 */
export function topicLookupOr(
  canonical: string,
  rawSpellings: string[]
): Prisma.SupportThreadWhereInput[] {
  const terms: Prisma.SupportThreadWhereInput[] = [
    { guid: canonical },
    { url: canonical },
  ];
  for (const raw of rawSpellings) {
    if (raw && raw !== canonical) terms.push({ guid: raw }, { url: raw });
  }
  const slug = topicSlug(canonical);
  if (slug) {
    terms.push(
      { guid: { contains: `/support/topic/${slug}/` } },
      { guid: { endsWith: `/support/topic/${slug}` } },
      { url: { contains: `/support/topic/${slug}/` } },
      { url: { endsWith: `/support/topic/${slug}` } }
    );
  }
  return terms;
}

/** What {@link applyThreadFromFetch} did to the SupportThread row. */
export type ThreadUpsertOutcome =
  /** Customer posted last on an existing tracked thread → flagged hasNewReply. */
  | "flagged"
  /** A new thread row was created (customer-last, or support-last on the mail path). */
  | "created"
  /** Support answered last on an existing thread → promise/waiting state recorded. */
  | "support_recorded"
  /** Support answered last on an untracked topic and creation wasn't requested. */
  | "skipped";

export interface ThreadUpsertResult {
  outcome: ThreadUpsertOutcome;
  /** The affected row id (existing or newly created); null for "skipped". */
  threadId: string | null;
  /**
   * Whether the LAST post on the thread is the customer's (the ball is with
   * the team) as of this upsert — true for "flagged" and a customer-last
   * "created" row, false for "support_recorded", a support-last "created"
   * row, and "skipped". Additive field so callers (the mail listener) can
   * tell a brand-new customer question apart from a support-last topic the
   * mail path merely tracked into its waiting state, without re-querying.
   */
  customerLast: boolean;
}

/**
 * Shared per-topic upsert, factored out of the resurface loop so the feed path
 * ({@link resurfaceReplies}) and the email-push path ({@link checkSingleTopic})
 * apply IDENTICAL state transitions from a freshly fetched thread. Given the
 * live thread and whether the last post is the customer's or the team's:
 *   - customer-last, existing → flag hasNewReply, bump lastActivityAt, clear
 *     any promise/waiting state;
 *   - customer-last, untracked → create the row (flagged) from the lead post;
 *   - support-last, existing → classify the follow-up promise, set
 *     followupPromisedAt/waitingSince accordingly, retire hasNewReply;
 *   - support-last, untracked → create the row in its waiting/promise state
 *     when `createOnSupportLast` (mail path), else skip (feed path — a
 *     support-last reply item on an untracked topic isn't actionable).
 * Always refreshes wpResolved from the fetched page. No drafting happens here
 * (cost control) — the admin regenerates.
 *
 * CRITICAL INVARIANT (HYBRID watermark): `lastReplyAt` is the feed dedupe
 * watermark and is sourced from EXACT feed pubDates only. Only the feed path
 * passes `exactReplyDate`; the mail path passes null and this function then
 * leaves lastReplyAt untouched (exactly like {@link refreshSilentTopics}) — an
 * inflated approximate watermark would silently skip a genuinely newer reply on
 * the next feed poll. The page's own per-post date still feeds lastActivityAt /
 * waitingSince / publishedAt, which only need day-scale accuracy.
 */
async function applyThreadFromFetch(opts: {
  pluginId: string;
  topicGuid: string;
  topicUrl: string;
  fetched: FetchedTopicThread;
  existing: { id: string } | null;
  /** Exact feed reply date (feed path) or null (mail path — no watermark write). */
  exactReplyDate: Date | null;
  /** Create a row when a support-last topic is untracked (mail path only). */
  createOnSupportLast: boolean;
  /**
   * Whether a customer-last CREATE carries the "New reply" badge (default
   * true — reply-triggered callers). The feed's new-TOPIC discovery passes
   * false: a topic seen for the first time has no "new reply", and nothing
   * downstream is guaranteed to clear the flag (drafting is skipped for gated
   * rows, --no-suggest runs, and graceful halts). Updates are unaffected.
   */
  flagCreateAsNewReply?: boolean;
}): Promise<ThreadUpsertResult> {
  const { fetched } = opts;
  const lastPost = fetched.posts[fetched.posts.length - 1];
  const firstPost = fetched.posts[0];
  // A bare (roleless) last post means the customer spoke last; a role badge
  // (Plugin Support/Author/…) means the team answered last.
  const customerLast = lastPost.role == null;
  // Clocks/badges prefer the page's own per-post date; fall back to the exact
  // feed date (feed path) then "now" (mail path, no date at all).
  const effectiveDate = lastPost.postedAt ?? opts.exactReplyDate ?? new Date();
  // Only an EXACT feed date may advance the dedupe watermark — see the HYBRID
  // invariant above.
  const watermark = opts.exactReplyDate
    ? { lastReplyAt: opts.exactReplyDate }
    : {};

  if (!customerLast) {
    if (opts.existing) {
      // Classify whether the team's last post promised a further update
      // ("let me check and get back to you"): YES arms the follow-up reminder;
      // NO hands the ball to the customer and starts the silence clock. The
      // classifier is best-effort and resolves to NO on failure.
      const promised = await classifyFollowupPromise(lastPost.text);
      await prisma.supportThread.update({
        where: { id: opts.existing.id },
        data: {
          ...watermark,
          followupPromisedAt: promised ? effectiveDate : null,
          waitingSince: promised ? null : effectiveDate,
          // The team answering ON wp.org retires any standing "New reply" flag.
          hasNewReply: false,
          wpResolved: fetched.resolved,
        },
      });
      return {
        outcome: "support_recorded",
        threadId: opts.existing.id,
        customerLast: false,
      };
    }
    if (!opts.createOnSupportLast) {
      return { outcome: "skipped", threadId: null, customerLast: false };
    }
    // Untracked topic whose team answered last (mail path): create the row in
    // its waiting/promise state so it can still surface in "Needs resolved".
    const promised = await classifyFollowupPromise(lastPost.text);
    const created = await prisma.supportThread.create({
      data: {
        pluginId: opts.pluginId,
        guid: opts.topicGuid,
        url: opts.topicUrl,
        title: fetched.title ?? opts.topicUrl,
        author: firstPost.author,
        excerpt: firstPost.text.slice(0, RESURFACE_EXCERPT_CHARS),
        publishedAt: firstPost.postedAt ?? null,
        status: "new",
        hasNewReply: false,
        ...watermark,
        lastActivityAt: effectiveDate,
        followupPromisedAt: promised ? effectiveDate : null,
        waitingSince: promised ? null : effectiveDate,
        wpResolved: fetched.resolved,
      },
    });
    return { outcome: "created", threadId: created.id, customerLast: false };
  }

  // Customer posted last — the ball is with the team.
  if (opts.existing) {
    await prisma.supportThread.update({
      where: { id: opts.existing.id },
      data: {
        hasNewReply: true,
        ...watermark,
        lastActivityAt: effectiveDate,
        // A fresh customer reply supersedes any pending promise / waiting state.
        followupPromisedAt: null,
        waitingSince: null,
        wpResolved: fetched.resolved,
      },
    });
    return { outcome: "flagged", threadId: opts.existing.id, customerLast: true };
  }
  const created = await prisma.supportThread.create({
    data: {
      pluginId: opts.pluginId,
      guid: opts.topicGuid,
      url: opts.topicUrl,
      title: fetched.title ?? opts.topicUrl,
      author: firstPost.author,
      // The topic's original publish date, from the lead post's own parsed
      // bbPress timestamp when available; null (unknown) otherwise.
      excerpt: firstPost.text.slice(0, RESURFACE_EXCERPT_CHARS),
      publishedAt: firstPost.postedAt ?? null,
      status: "new",
      hasNewReply: opts.flagCreateAsNewReply ?? true,
      ...watermark,
      lastActivityAt: effectiveDate,
      // Customer posted last — ball is with the team, not waiting on them.
      waitingSince: null,
      wpResolved: fetched.resolved,
    },
  });
  return { outcome: "created", threadId: created.id, customerLast: true };
}

/**
 * Resurface topics that got a fresh customer reply. For each plugin's reply
 * feed items (newest kept per topic) within the age cutoff, cheaply dedupe by
 * the stored lastReplyAt, then fetch the live thread ONCE and inspect the last
 * post's role:
 *   - support-team-last → record lastReplyAt (so a later check won't refetch)
 *     but do NOT flag/create;
 *   - customer-last + existing thread → flag hasNewReply + bump dates;
 *   - customer-last + missing thread → create it from the fetched first post.
 * No drafting happens here (cost control) — the admin regenerates.
 */
async function resurfaceReplies(
  plugin: { id: string; name: string },
  replies: ForumReply[],
  ageCutoffMs: number,
  result: WatcherResult,
  state: CheckProgress,
  /** Ids flagged hasNewReply this run — lets the drafting phase restore the flag. */
  flaggedIds: Set<string>
): Promise<void> {
  // Collapse to the newest reply per topic so each topic is fetched at most
  // once per check, regardless of feed ordering or several reply items.
  const newestByTopic = new Map<string, ForumReply>();
  for (const reply of replies) {
    // No date → can't age-check or dedupe cheaply; skip (avoids a refetch).
    if (!reply.publishedAt) continue;
    // The cutoff applies to the REPLY date — the topic itself may be years old.
    if (reply.publishedAt.getTime() < ageCutoffMs) continue;
    // Key by the canonical permalink so two spellings of one topic in the same
    // batch (e.g. with and without a /page/N/ suffix) collapse to one fetch.
    const key = canonicalizeTopicUrl(reply.topicGuid) ?? reply.topicGuid;
    const seen = newestByTopic.get(key);
    if (!seen || reply.publishedAt > seen.publishedAt!) {
      newestByTopic.set(key, reply);
    }
  }

  for (const reply of newestByTopic.values()) {
    // Honour Pause/Stop promptly — each candidate costs a politeness sleep
    // plus a live-thread fetch. Unprocessed replies are retried (and deduped
    // via lastReplyAt) on the next check.
    if (state.cancelRequested) break;
    const replyDate = reply.publishedAt!;
    // Store keys are the canonical permalink; the lookup also matches raw feed
    // spellings and slug-anchored legacy rows (see topicLookupOr).
    const canonicalGuid = canonicalizeTopicUrl(reply.topicGuid) ?? reply.topicGuid;
    const canonicalUrl = canonicalizeTopicUrl(reply.topicUrl) ?? reply.topicUrl;
    const existing = await prisma.supportThread.findFirst({
      where: {
        pluginId: plugin.id,
        OR: topicLookupOr(canonicalGuid, [reply.topicGuid, reply.topicUrl]),
      },
      select: { id: true, lastReplyAt: true },
    });
    // Already processed a reply at least this recent — nothing new.
    if (existing?.lastReplyAt && existing.lastReplyAt >= replyDate) continue;

    // Fetch the live thread once to read the last post's role. Be polite.
    // NOTE: fetchTopicThread's underlying fetchHtml swallows network/HTTP
    // failures and returns null (handled below); this catch only fires on
    // unexpected throws (e.g. a parser bug) — belt and braces, not the
    // ordinary failure path.
    await sleep(FEED_POLITENESS_MS);
    let fetched;
    try {
      fetched = await fetchTopicThread(reply.topicUrl);
    } catch (error) {
      result.errors.push(
        `resurface ${reply.topicUrl}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    // Fetch failed or nothing parsed — leave it for the next check to retry.
    if (!fetched || fetched.posts.length === 0) continue;

    // Delegate the state transition to the shared upsert (same logic the mail
    // path uses). The feed path passes the EXACT reply pubDate so the dedupe
    // watermark advances, and does NOT create rows for support-last untracked
    // topics (not actionable from a bare reply feed item).
    const applied = await applyThreadFromFetch({
      pluginId: plugin.id,
      topicGuid: canonicalGuid,
      topicUrl: canonicalUrl,
      fetched,
      existing: existing ? { id: existing.id } : null,
      exactReplyDate: replyDate,
      createOnSupportLast: false,
    });

    // Only a customer-last flag/create counts as a resurface; the drafting
    // phase restores the badge for rows created-and-flagged in one poll.
    if (applied.outcome === "flagged" || applied.outcome === "created") {
      if (applied.threadId) flaggedIds.add(applied.threadId);
      result.resurfaced += 1;
      state.resurfaced += 1;
    }
  }
}

/**
 * Waiting-clock refresh pass, re-polling every thread currently "waiting on
 * customer" (SupportThread.waitingSince set). wp.org emits no feed item when a
 * topic is marked resolved or (occasionally) when a reply lands, so these
 * would otherwise never update. This used to only re-check topics already
 * PAST the silence threshold (the "Needs resolved" candidates); it now covers
 * every waiting thread (still bounded, oldest first) so a clock that was
 * started from an approximate fallback (see followup.ts's waitingSincePatch)
 * and landed on the wrong side of the threshold can self-heal on the next
 * check — not just topics that already look overdue. Re-fetch the batch and:
 *   (a) refresh wpResolved — a now-resolved topic drops out of the tab;
 *   (b) if the newest post is a fresh CUSTOMER reply the feed missed, apply the
 *       same customer-last handling as {@link resurfaceReplies} (flag, bump
 *       dates, clear the waiting/promise state);
 *   (c) if the newest post is still support-side, retro-correct waitingSince
 *       to that post's own parsed date when it disagrees with the stored value
 *       by more than an hour — same rule as followup.ts's RETRO-CORRECTION:
 *       the stored value came from an approximate fallback; the page's own
 *       timestamp is authoritative once we have it.
 * Bounded to {@link SILENT_REFRESH_CAP}, oldest waitingSince first, and honours
 * Pause/Stop between fetches.
 */
async function refreshSilentTopics(
  pluginId: string | undefined,
  result: WatcherResult,
  state: CheckProgress,
  /** Restrict the pass to specific rows (digest pre-send verification). */
  threadIds?: string[]
): Promise<void> {
  const waiting = await prisma.supportThread.findMany({
    where: {
      ...(threadIds ? { id: { in: threadIds } } : {}),
      waitingSince: { not: null },
      wpResolved: false,
      // The two modes deliberately filter differently (owner-reported bug:
      // a digest candidate that never matched the check-time filters below
      // was announced daily but NEVER re-verified, so its stale wpResolved
      // stuck forever):
      //  - id-scoped (digest pre-send verification): the caller has already
      //    decided these rows are about to be ANNOUNCED — verify every one
      //    of them. No deadband (≤20 fetches/day is cheap next to a wrong
      //    nag), no reviewed-exclusion (the digest includes reviewed rows),
      //    no plugin-slug requirement (the fetch uses thread.url directly).
      //  - full pass (forum checks): keep the cost guards as designed.
      ...(threadIds
        ? { status: { not: "dismissed" } }
        : {
            // Cost guard (review finding): a row touched within the last
            // hour — synced, regenerated, or refreshed by the previous
            // check — has nothing new to learn from another fetch.
            updatedAt: { lt: new Date(Date.now() - ONE_HOUR_MS) },
            // A human already acting on it (reviewed/dismissed) opts it out.
            status: { notIn: ["dismissed", "reviewed"] },
            plugin: { wpOrgSlug: { not: null } },
          }),
      ...(pluginId ? { pluginId } : {}),
    },
    select: { id: true, url: true, waitingSince: true, followupPromisedAt: true },
    // Oldest waiters first — the topics most overdue for a close.
    orderBy: { waitingSince: "asc" },
    take: SILENT_REFRESH_CAP,
  });

  // The id-scoped mode (digest pre-send verification) logs every step —
  // owner escalation: the same resolved topic survived multiple "fixes"
  // because every failure in this loop was a silent `continue`, leaving no
  // trace of WHY a candidate kept its stale flags.
  const verbose = threadIds != null;

  for (const thread of waiting) {
    // Honour Pause/Stop promptly — each candidate costs a fetch.
    if (state.cancelRequested) break;
    await sleep(FEED_POLITENESS_MS);
    let fetched;
    // Same as the resurface loop: ordinary fetch failures surface as null
    // (skipped below); the catch is only for unexpected throws.
    try {
      fetched = await fetchTopicThread(thread.url);
    } catch (error) {
      result.errors.push(
        `silent-refresh ${thread.url}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    if (!fetched) {
      if (verbose) {
        console.warn(
          `[digest-refresh] ${thread.url}: page fetch FAILED (network/HTTP) — flags left as-is`
        );
      }
      continue;
    }
    if (fetched.posts.length === 0) {
      // The page loaded but no posts parsed (markup drift, layout change).
      // The RESOLVED flag comes from the page head, not the posts — update
      // it anyway so a resolved topic still drops out of "Needs resolved"
      // even when the post markup defeats the parser.
      if (verbose) {
        console.warn(
          `[digest-refresh] ${thread.url}: page loaded but 0 posts parsed — ` +
            `updating wpResolved=${fetched.resolved} only`
        );
      }
      await prisma.supportThread.update({
        where: { id: thread.id },
        data: { wpResolved: fetched.resolved },
      });
      continue;
    }
    if (verbose) {
      console.log(
        `[digest-refresh] ${thread.url}: fetched ${fetched.posts.length} posts, ` +
          `resolved=${fetched.resolved}, lastPostRole=${fetched.posts[fetched.posts.length - 1].role ?? "customer"}`
      );
    }

    const lastPost = fetched.posts[fetched.posts.length - 1];
    const customerLast = lastPost.role == null;

    if (customerLast) {
      // A customer reply the feed missed — treat exactly like a resurfaced
      // customer-last reply: flag it and hand the ball back to the team.
      // Prefer the page's own per-post date; fall back to "now" only when
      // the meta timestamp didn't parse.
      const replyDate = lastPost.postedAt ?? new Date();
      // lastReplyAt (the feed dedupe watermark) is deliberately NOT written
      // here: this date is approximate, and inflating the watermark could
      // skip a genuinely newer reply on the next feed poll. Worst case the
      // feed reprocesses this same reply once — idempotent (hasNewReply is
      // already true by then).
      await prisma.supportThread.update({
        where: { id: thread.id },
        data: {
          hasNewReply: true,
          lastActivityAt: replyDate,
          followupPromisedAt: null,
          waitingSince: null,
          wpResolved: fetched.resolved,
        },
      });
      result.resurfaced += 1;
      state.resurfaced += 1;
    } else {
      // Still support-last: refresh the resolution flag, and retro-correct the
      // waiting clock when the page's own timestamp disagrees with the stored
      // value by more than an hour. waitingSince and followupPromisedAt are
      // mutually exclusive elsewhere in this codebase (a promise owns the
      // reminder instead of the waiting clock), so followupPromisedAt should
      // already be null here — the check is defensive, not load-bearing.
      const lastPostAt = lastPost.postedAt;
      const needsRetroCorrection =
        thread.followupPromisedAt == null &&
        lastPostAt != null &&
        thread.waitingSince != null &&
        Math.abs(lastPostAt.getTime() - thread.waitingSince.getTime()) > ONE_HOUR_MS;
      await prisma.supportThread.update({
        where: { id: thread.id },
        data: {
          wpResolved: fetched.resolved,
          ...(needsRetroCorrection ? { waitingSince: lastPostAt } : {}),
        },
      });
    }
  }
}

/** True while a forum check is in progress (delegates to the check-state singleton). */
export function isWatcherRunning(): boolean {
  return isCheckRunning();
}

/**
 * Standalone resolution-refresh for callers OUTSIDE a forum check — today the
 * daily needs-resolved digest (src/lib/notify/digest.ts). wp.org's "mark as
 * resolved" emits no feed item AND no notification email, so once the mail
 * listener made manual/cron checks rare, wpResolved flags went stale and the
 * digest nagged about topics already resolved on the forum (owner report).
 * Runs the exact same pass a forum check runs (same cap, same 1-hour
 * updatedAt deadband, same politeness delay); skips entirely while a real
 * check is running — that check performs the pass itself. Never throws.
 *
 * `threadIds` scopes the pass to specific rows — the digest passes exactly
 * the candidates it is about to announce (owner request: verify what you're
 * about to send, not the whole waiting set — 2 stale candidates should cost
 * 2 fetches, not 20).
 */
export async function refreshWaitingTopicsStandalone(
  threadIds?: string[]
): Promise<void> {
  if (isCheckRunning()) return;
  if (threadIds && threadIds.length === 0) return;
  const result: WatcherResult = {
    pluginsChecked: 0,
    newThreads: 0,
    drafted: 0,
    skippedOld: 0,
    resurfaced: 0,
    skippedHandled: 0,
    status: "completed",
    lastIndex: null,
    errors: [],
  };
  // Not a real check run — a detached object satisfies the pass's
  // cancel/counter hooks without touching the live check-state singleton.
  const state = { cancelRequested: false, resurfaced: 0 } as CheckProgress;
  try {
    await refreshSilentTopics(undefined, result, state, threadIds);
    for (const message of result.errors) {
      console.error("[digest-refresh]", message);
    }
  } catch (error) {
    console.error(
      "[digest-refresh] pass failed:",
      error instanceof Error ? error.message : error
    );
  }
}

/** Outcome of a {@link checkSingleTopic} call — for the mail listener's logs. */
export interface SingleTopicResult {
  outcome: ThreadUpsertOutcome | "fetch_failed";
  threadId: string | null;
  /** See {@link ThreadUpsertResult.customerLast}; always false for "fetch_failed". */
  customerLast: boolean;
}

/**
 * Check ONE wp.org topic on demand, given the plugin it belongs to and its
 * (any-form) topic URL. The near-realtime email-push path
 * (src/lib/wporg/mail-listener.ts) calls this within seconds of a wp.org
 * notification email, so the RSS cron can be relaxed.
 *
 * Fetches the live thread ONCE and applies the exact same state transitions as
 * the feed's resurface pass via {@link applyThreadFromFetch}, EXCEPT it passes
 * no exact reply date — so, like the refresh pass, it never advances the
 * lastReplyAt feed dedupe watermark (see the HYBRID invariant). It creates the
 * row when the topic is untracked (new-topic notifications land here), including
 * the support-last case. This function itself never drafts — the caller
 * (mail-listener.ts) auto-drafts a freshly created CUSTOMER-LAST row (see
 * {@link ThreadUpsertResult.customerLast}) and, for a customer reply on an
 * already-tracked topic ("flagged"), generates a whole-thread follow-up draft
 * for its Slack "new reply" notification; a support-last topic merely
 * recorded into its waiting state is left for the manual Regenerate action.
 * Idempotent:
 * re-processing the same notification is a no-op upsert, and it is safe to run
 * concurrently with a full forum check (both are idempotent upserts on the
 * same rows).
 */
export async function checkSingleTopic(
  pluginId: string,
  topicUrl: string
): Promise<SingleTopicResult> {
  // Canonicalize to the bare topic permalink so guid/url line up with how the
  // feed stores the same topic (strips #anchor, query, /page/N/).
  const canonical = canonicalizeTopicUrl(topicUrl) ?? canonicalForumUrl(topicUrl);

  let fetched;
  try {
    fetched = await fetchTopicThread(canonical);
  } catch (error) {
    console.error(
      `[wporg-mail] fetch failed ${canonical}:`,
      error instanceof Error ? error.message : error
    );
    return { outcome: "fetch_failed", threadId: null, customerLast: false };
  }
  if (!fetched || fetched.posts.length === 0) {
    return { outcome: "fetch_failed", threadId: null, customerLast: false };
  }

  // Match an existing row by canonical guid/url or any slug-anchored legacy
  // spelling — the feed and mail paths must converge on the same row even when
  // they arrived at slightly different stored strings for one topic.
  const existing = await prisma.supportThread.findFirst({
    where: { pluginId, OR: topicLookupOr(canonical, [topicUrl]) },
    select: { id: true },
  });

  return applyThreadFromFetch({
    pluginId,
    topicGuid: canonical,
    topicUrl: canonical,
    fetched,
    existing,
    exactReplyDate: null,
    createOnSupportLast: true,
  });
}

/**
 * Push a Slack notification for a newly created customer-last topic found by
 * this run's feed pass (see the `withSuggestions` drafting phase in
 * {@link checkPluginForums}). Every row in `newThreadIds` is customer-last by
 * construction — a feed topic item is always a fresh customer question, never
 * a support-team reply — so unlike the mail listener's
 * {@link SingleTopicResult.customerLast} check, no extra filtering is needed
 * here. Re-reads the thread's freshest fields (including plugin name, via a
 * minimal relation select) rather than threading them through from the topic-
 * creation loop, so a draft written just before this call — success or
 * failure — is always reflected. No-op (skips the DB read) when Slack isn't
 * configured. Callers are responsible for failure isolation.
 */
async function notifyNewTopicSlack(threadId: string): Promise<void> {
  if (!slackConfigured()) return;
  const thread = await prisma.supportThread.findUnique({
    where: { id: threadId },
    select: {
      title: true,
      url: true,
      author: true,
      excerpt: true,
      draftAnswer: true,
      plugin: { select: { name: true } },
    },
  });
  if (!thread) return;
  await notifySlackTopic({
    kind: "new_topic",
    pluginName: thread.plugin.name,
    title: thread.title,
    url: thread.url,
    author: thread.author,
    excerpt: thread.excerpt,
    threadId,
    draftAnswer: thread.draftAnswer,
  });
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function checkPluginForums(options?: {
  /** Generate LLM drafts for newly found threads (default true). */
  withSuggestions?: boolean;
  /** Restrict the check to one plugin. */
  pluginId?: string;
  /** Resume: skip plugins before this 1-based (alphabetical) index. */
  startIndex?: number;
}): Promise<WatcherResult> {
  const state = getCheckProgress();
  if (state.running) {
    throw new Error("A forum check is already running");
  }
  // Claim the singleton synchronously (before the first await) so a concurrent
  // start can't slip past the guard above.
  beginCheckProgress();

  // Record the run durably. If even this fails, release the guard and bail.
  let checkLogId: string;
  try {
    const log = await prisma.forumCheckLog.create({
      data: { status: "running" },
      select: { id: true },
    });
    checkLogId = log.id;
    state.checkLogId = checkLogId;
  } catch (error) {
    endCheckProgress();
    throw error;
  }

  const result: WatcherResult = {
    pluginsChecked: 0,
    newThreads: 0,
    drafted: 0,
    skippedOld: 0,
    resurfaced: 0,
    skippedHandled: 0,
    status: "completed",
    lastIndex: null,
    errors: [],
  };

  // Topics published before this instant are too old to bother with.
  const maxAgeDays = getEnv().WPORG_TOPIC_MAX_AGE_DAYS;
  const ageCutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;

  try {
    // Deterministic alphabetical order — this defines each plugin's 1-based
    // index used by pause/continue.
    const plugins = await prisma.plugin.findMany({
      where: {
        wpOrgSlug: { not: null },
        ...(options?.pluginId ? { id: options.pluginId } : {}),
      },
      select: { id: true, name: true, wpOrgSlug: true },
      orderBy: { name: "asc" },
    });
    state.pluginsTotal = plugins.length;

    // Clamp the resume start to the real plugin range — an out-of-range
    // startIndex would otherwise record a bogus lastIndex that permanently
    // inflates the resume suggestion (computeResumeIndex takes the max).
    const startIndex = Math.min(
      Math.max(options?.startIndex ?? 1, 1),
      Math.max(plugins.length, 1)
    );

    const newThreadIds: string[] = [];
    // Threads flagged hasNewReply this run — the drafting phase clears the
    // flag as a side effect of generateSuggestionForThread, so it must be
    // restored for threads that were both created and resurfaced in one poll.
    const flaggedIds = new Set<string>();
    let halted: CheckHaltReason | null = null;
    let lastIndex = startIndex - 1;

    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i];
      const index = i + 1; // 1-based, alphabetical
      if (index < startIndex) continue; // resume: skip earlier plugins
      if (!plugin.wpOrgSlug) {
        lastIndex = index;
        continue;
      }

      // Graceful halt requested — stop cleanly between plugins.
      if (state.cancelRequested) {
        halted = state.cancelReason;
        break;
      }

      state.currentIndex = index;
      state.currentPlugin = plugin.name;
      state.currentFeedTopics = null;
      result.pluginsChecked += 1;
      try {
        const { topics, replies } = await fetchForumFeed(plugin.wpOrgSlug);
        state.currentFeedTopics = topics.length;
        for (const topic of topics) {
          // Honour Pause/Stop promptly — same convention as resurfaceReplies
          // and refreshSilentTopics, and for the same reason: each NEW topic
          // now costs a politeness sleep plus a live page fetch. The
          // mid-plugin-halt check after the try/catch below keeps this
          // plugin's lastIndex un-advanced, so Continue redoes it (idempotent
          // — the existing-row lookup skips rows already created).
          if (state.cancelRequested) break;
          // Skip topics older than the cutoff. Topics with no publish date
          // are kept — their age is unknown, so we can't rule them out.
          if (topic.publishedAt && topic.publishedAt.getTime() < ageCutoffMs) {
            result.skippedOld += 1;
            state.skippedOld += 1;
            continue;
          }
          // Store keys are the canonical permalink; the lookup also matches
          // raw feed spellings and slug-anchored legacy rows (including rows
          // the mail path created first), so both paths converge on one row.
          const canonicalGuid = canonicalizeTopicUrl(topic.guid) ?? topic.guid;
          const canonicalUrl = canonicalizeTopicUrl(topic.url) ?? topic.url;
          const existing = await prisma.supportThread.findFirst({
            where: {
              pluginId: plugin.id,
              OR: topicLookupOr(canonicalGuid, [topic.guid, topic.url]),
            },
            select: { id: true },
          });
          if (existing) continue;

          // FETCH-BEFORE-CREATE (owner incident): a feed item alone can't
          // tell a genuinely new topic from an old, already-answered one
          // still sitting in a quiet forum's RSS — the feed carries no
          // resolution or reply-role information, so blindly creating from
          // it once produced a draft + "New wp.org topic" Slack post for a
          // topic that was actually RESOLVED with 3 support replies. Fetch
          // the live page ONCE, exactly like the mail path
          // (checkSingleTopic) and the resurface pass do, and let
          // applyThreadFromFetch decide the row's real state.
          await sleep(FEED_POLITENESS_MS);
          let fetched: FetchedTopicThread | null = null;
          try {
            fetched = await fetchTopicThread(canonicalUrl);
          } catch (error) {
            // Same as resurfaceReplies: fetchTopicThread's own fetchHtml
            // swallows network/HTTP failures and returns null (handled
            // below); this catch only fires on an unexpected throw (e.g. a
            // parser bug) — belt and braces, not the ordinary failure path.
            result.errors.push(
              `feed new-topic fetch ${canonicalUrl}: ${error instanceof Error ? error.message : String(error)}`
            );
          }

          if (!fetched || fetched.posts.length === 0) {
            // FALLBACK: availability over perfection. A fetch hiccup (503,
            // timeout, markup drift) must not silently swallow a genuinely
            // new topic — create straight from the feed item exactly like
            // this branch always did before this change, so it still gets
            // drafted and Slack-notified.
            console.warn(
              `[wporg] feed new-topic page fetch failed for ${canonicalUrl} — ` +
                "falling back to feed-only creation (today's behavior)"
            );
            const thread = await prisma.supportThread.create({
              data: {
                pluginId: plugin.id,
                guid: canonicalGuid,
                url: canonicalUrl,
                title: topic.title,
                author: topic.author,
                excerpt: topic.excerpt,
                publishedAt: topic.publishedAt,
                // lastActivityAt drives the "Recent" tab: the publish date for a
                // fresh topic (falling back to now when the feed omits it).
                lastActivityAt: topic.publishedAt ?? new Date(),
              },
            });
            result.newThreads += 1;
            state.newThreads += 1;
            newThreadIds.push(thread.id);
            continue;
          }

          // Page fetched successfully — apply the SAME state transitions the
          // mail path uses (createOnSupportLast: true creates the row
          // whichever side posted last). No exact reply date: this is a NEW
          // topic, not a reply, so — same HYBRID-watermark reasoning as
          // checkSingleTopic — lastReplyAt is left untouched.
          const applied = await applyThreadFromFetch({
            pluginId: plugin.id,
            topicGuid: canonicalGuid,
            topicUrl: canonicalUrl,
            fetched,
            existing: null,
            exactReplyDate: null,
            createOnSupportLast: true,
            // New-topic discovery, not a reply event — see the option's doc.
            flagCreateAsNewReply: false,
          });
          // Count every row created (actionable or not) — mirrors today's
          // newThreads semantics.
          result.newThreads += 1;
          state.newThreads += 1;

          if (applied.threadId) {
            // Backfill fields the FEED knows better than the page, so a
            // page-parse gap can never leave the row worse than today's
            // feed-only creation:
            //  - title: applyThreadFromFetch falls back to the bare topic
            //    URL when the page's <title> didn't parse; the feed's own
            //    title is always the better fallback.
            //  - author: the page parser's own "nothing found" placeholder
            //    is the literal string "anonymous" (see parseTopicPage in
            //    forum-crawler.ts); the feed's dc:creator, when present, is
            //    a real name and wins over that placeholder.
            //  - publishedAt: the feed's pubDate is an exact timestamp; the
            //    page only offers a coarse "N days ago" relative parse (or
            //    nothing), so the feed date wins whenever the feed has one.
            //  - lastActivityAt: only overridden when the page gave NOTHING
            //    (the last post's relative-time parse failed, so
            //    applyThreadFromFetch fell all the way back to "now") — the
            //    feed's publish date is a better guess than "now" for a
            //    freshly-created topic.
            const firstPost = fetched.posts[0];
            const lastPost = fetched.posts[fetched.posts.length - 1];
            const backfill: Prisma.SupportThreadUpdateInput = {};
            if (!fetched.title && topic.title) backfill.title = topic.title;
            if (firstPost.author === "anonymous" && topic.author) {
              backfill.author = topic.author;
            }
            if (topic.publishedAt) {
              backfill.publishedAt = topic.publishedAt;
              if (!lastPost.postedAt) backfill.lastActivityAt = topic.publishedAt;
            }
            if (Object.keys(backfill).length > 0) {
              await prisma.supportThread.update({
                where: { id: applied.threadId },
                data: backfill,
              });
            }

            // Draft + Slack-notify gate (owner incident): only an actionable
            // topic — freshly created, the ball genuinely with the team, and
            // NOT already resolved on wp.org — gets a draft and a
            // notification. A resolved or support-last topic is stored with
            // correct flags (and still shows up in the right /suggestions
            // tab) but is never drafted or announced, matching what the mail
            // path already does for a support-last topic.
            if (
              applied.outcome === "created" &&
              applied.customerLast &&
              !fetched.resolved
            ) {
              newThreadIds.push(applied.threadId);
            } else {
              result.skippedHandled += 1;
              state.skippedHandled += 1;
            }
          }
        }
        // Resurface old topics bumped by a fresh customer reply (reply items).
        await resurfaceReplies(plugin, replies, ageCutoffMs, result, state, flaggedIds);
      } catch (error) {
        const message = `${plugin.name}: ${error instanceof Error ? error.message : String(error)}`;
        console.error("Forum check failed for", message);
        result.errors.push(message);
      }
      // A halt that landed MID-plugin (topics loop or resurfaceReplies both
      // break per item) must not count this plugin as processed — advancing
      // lastIndex here would make Continue silently skip its remaining
      // topics. Leaving it un-advanced is safe: redoing the plugin is
      // idempotent (existing-row lookup + lastReplyAt dedupe).
      if (state.cancelRequested) {
        halted = state.cancelReason;
        break;
      }
      state.pluginsDone += 1;
      lastIndex = index;
      // Be polite to wp.org between feeds.
      await sleep(500);
    }

    result.lastIndex = lastIndex;
    result.status = halted ?? "completed";

    // Re-poll every waiting-on-customer thread for a resolution flip, a missed
    // customer reply, or a waitingSince retro-correction (skipped on a
    // graceful halt, like drafting). Folds any missed customer reply into the
    // resurfaced counter.
    if (!halted) {
      try {
        await refreshSilentTopics(options?.pluginId, result, state);
      } catch (error) {
        result.errors.push(
          `silent-refresh pass: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Draft suggestions for the topics just found — but skip drafting entirely
    // on a graceful halt (keep it cheap; the new threads stay status "new" for
    // the "Generate missing drafts" action or a later check to pick up).
    //
    // Slack scope: ONLY the newly created topics below notify — resurfaced/
    // flagged customer replies deliberately do NOT notify from the feed path.
    // The mail listener owns reply notifications, and because the mail path
    // never advances the lastReplyAt feed dedupe watermark (the HYBRID
    // invariant in applyThreadFromFetch), this feed poll later re-processes
    // the very same reply the mail path already announced — notifying on
    // flagged/resurfaced outcomes here would post every reply to Slack twice.
    // New-topic notifications are safe on both paths: the existing-row lookup
    // means each topic is only ever CREATED (and hence announced) once.
    if (!halted && (options?.withSuggestions ?? true)) {
      state.phase = "drafting";
      // The drafting denominator is the QUEUE length, not newThreads — rows
      // gated by the fetch-before-create check are created but never queued,
      // and a draftsDone/newThreads fraction would visibly stall below 1.
      state.draftsTotal = newThreadIds.length;
      for (const threadId of newThreadIds) {
        try {
          const suggestion = await generateSuggestionForThread(threadId);
          if (suggestion.draftAnswer) {
            result.drafted += 1;
            state.drafted += 1;
          }
          // Drafting clears hasNewReply; a topic that was created AND
          // resurfaced in this same poll must keep its badge.
          if (flaggedIds.has(threadId)) {
            await prisma.supportThread.update({
              where: { id: threadId },
              data: { hasNewReply: true },
            });
          }
        } catch (error) {
          result.errors.push(
            `suggestion ${threadId}: ${error instanceof Error ? error.message : String(error)}`
          );
        } finally {
          state.draftsDone += 1;
        }

        // Slack push for this newly created topic — failure-isolated per
        // thread, and deliberately no extra retry loop here beyond
        // notifySlackTopic's own single retry (keep the drafting loop from
        // slowing down on a flaky webhook).
        try {
          await notifyNewTopicSlack(threadId);
        } catch (error) {
          result.errors.push(
            `slack notify ${threadId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    await prisma.forumCheckLog.update({
      where: { id: checkLogId },
      data: {
        status: result.status,
        finishedAt: new Date(),
        pluginsChecked: result.pluginsChecked,
        newThreads: result.newThreads,
        drafted: result.drafted,
        skippedOld: result.skippedOld,
        resurfaced: result.resurfaced,
        lastIndex: result.lastIndex,
        errors: result.errors,
      },
    });
    console.log(
      `[wporg] check ${result.status}: ${result.pluginsChecked} plugins, ${result.newThreads} new, ` +
        `${result.resurfaced} resurfaced, ${result.drafted} drafted, ${result.skippedOld} skipped (old), ` +
        `${result.skippedHandled} skipped (resolved/support-last), ${result.errors.length} error(s)`
    );
    return result;
  } catch (error) {
    // Catastrophic failure (not a per-plugin feed error — those are caught in
    // the loop above and recorded in result.errors while the run completes).
    const message = error instanceof Error ? error.message : String(error);
    console.error("Forum check run failed:", error);
    result.errors.push(message);
    result.status = "failed";
    await prisma.forumCheckLog
      .update({
        where: { id: checkLogId },
        data: {
          status: "failed",
          finishedAt: new Date(),
          pluginsChecked: result.pluginsChecked,
          newThreads: result.newThreads,
          drafted: result.drafted,
          skippedOld: result.skippedOld,
          resurfaced: result.resurfaced,
          lastIndex: result.lastIndex,
          errors: result.errors,
        },
      })
      .catch((e) => console.error("Failed to record forum check failure:", e));
    throw error;
  } finally {
    endCheckProgress();
  }
}
