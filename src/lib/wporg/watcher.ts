import { prisma } from "@/lib/db";
import { getEnv } from "@/env";
import { classifyFollowupPromise } from "@/lib/suggest/promise";
import { generateSuggestionForThread } from "@/lib/suggest/suggester";
import { fetchTopicThread } from "@/lib/wporg/forum-crawler";
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
    const seen = newestByTopic.get(reply.topicGuid);
    if (!seen || reply.publishedAt > seen.publishedAt!) {
      newestByTopic.set(reply.topicGuid, reply);
    }
  }

  for (const reply of newestByTopic.values()) {
    // Honour Pause/Stop promptly — each candidate costs a politeness sleep
    // plus a live-thread fetch. Unprocessed replies are retried (and deduped
    // via lastReplyAt) on the next check.
    if (state.cancelRequested) break;
    const replyDate = reply.publishedAt!;
    const existing = await prisma.supportThread.findUnique({
      where: { pluginId_guid: { pluginId: plugin.id, guid: reply.topicGuid } },
      select: { id: true, lastReplyAt: true },
    });
    // Already processed a reply at least this recent — nothing new.
    if (existing?.lastReplyAt && existing.lastReplyAt >= replyDate) continue;

    // Fetch the live thread once to read the last post's role. Be polite.
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

    const lastPost = fetched.posts[fetched.posts.length - 1];
    // wp.org tags support-team posts with a role badge; a bare (roleless) last
    // post means the customer spoke last and the thread is waiting on support.
    const customerLast = lastPost.role == null;

    if (!customerLast) {
      // Support answered last. Record lastReplyAt to skip refetching next time;
      // don't flag, and don't create a row for a topic we weren't tracking.
      // For a tracked thread, classify whether that last post promised a
      // further update the team may forget ("let me check and get back to
      // you"): YES arms the follow-up reminder (followupPromisedAt = this reply
      // date); NO clears any prior promise (the team delivered or closed). The
      // classifier is best-effort — a failure resolves to NO and never blocks
      // the check. We only reach here when the reply is newer than the last one
      // processed, so a standing promise isn't re-classified every check.
      if (existing) {
        const promised = await classifyFollowupPromise(lastPost.text);
        await prisma.supportThread.update({
          where: { id: existing.id },
          data: {
            lastReplyAt: replyDate,
            followupPromisedAt: promised ? replyDate : null,
          },
        });
      }
      continue;
    }

    if (existing) {
      await prisma.supportThread.update({
        where: { id: existing.id },
        data: {
          hasNewReply: true,
          lastReplyAt: replyDate,
          lastActivityAt: replyDate,
          // A fresh customer reply supersedes any pending support promise —
          // the ball is back with the team via the "New reply" badge instead.
          followupPromisedAt: null,
        },
      });
      flaggedIds.add(existing.id);
    } else {
      const firstPost = fetched.posts[0];
      const created = await prisma.supportThread.create({
        data: {
          pluginId: plugin.id,
          guid: reply.topicGuid,
          url: reply.topicUrl,
          title: fetched.title ?? reply.topicUrl,
          author: firstPost.author,
          // parseTopicPage carries no per-post dates, so the topic's original
          // publish date is unknown here — left null. lastActivityAt still
          // sorts it into "Recent" by the reply date.
          excerpt: firstPost.text.slice(0, RESURFACE_EXCERPT_CHARS),
          publishedAt: null,
          status: "new",
          hasNewReply: true,
          lastReplyAt: replyDate,
          lastActivityAt: replyDate,
        },
      });
      flaggedIds.add(created.id);
    }
    result.resurfaced += 1;
    state.resurfaced += 1;
  }
}

/** True while a forum check is in progress (delegates to the check-state singleton). */
export function isWatcherRunning(): boolean {
  return isCheckRunning();
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
          // Skip topics older than the cutoff. Topics with no publish date
          // are kept — their age is unknown, so we can't rule them out.
          if (topic.publishedAt && topic.publishedAt.getTime() < ageCutoffMs) {
            result.skippedOld += 1;
            state.skippedOld += 1;
            continue;
          }
          const existing = await prisma.supportThread.findUnique({
            where: { pluginId_guid: { pluginId: plugin.id, guid: topic.guid } },
            select: { id: true },
          });
          if (existing) continue;
          const thread = await prisma.supportThread.create({
            data: {
              pluginId: plugin.id,
              guid: topic.guid,
              url: topic.url,
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
        }
        // Resurface old topics bumped by a fresh customer reply (reply items).
        await resurfaceReplies(plugin, replies, ageCutoffMs, result, state, flaggedIds);
      } catch (error) {
        const message = `${plugin.name}: ${error instanceof Error ? error.message : String(error)}`;
        console.error("Forum check failed for", message);
        result.errors.push(message);
      }
      state.pluginsDone += 1;
      lastIndex = index;
      // Be polite to wp.org between feeds.
      await sleep(500);
    }

    result.lastIndex = lastIndex;
    result.status = halted ?? "completed";

    // Draft suggestions for the topics just found — but skip drafting entirely
    // on a graceful halt (keep it cheap; the new threads stay status "new" for
    // the "Generate missing drafts" action or a later check to pick up).
    if (!halted && (options?.withSuggestions ?? true)) {
      state.phase = "drafting";
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
        `${result.errors.length} error(s)`
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
