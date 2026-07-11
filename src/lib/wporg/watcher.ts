import { prisma } from "@/lib/db";
import { getEnv } from "@/env";
import { generateSuggestionForThread } from "@/lib/suggest/suggester";
import {
  beginCheckProgress,
  endCheckProgress,
  getCheckProgress,
  isCheckRunning,
  type CheckHaltReason,
} from "./check-state";
import { fetchForumTopics } from "./feed";

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
  /** Terminal status of the run. */
  status: "completed" | "paused" | "cancelled" | "failed";
  /** Highest 1-based plugin index fully processed (the resume point). */
  lastIndex: number | null;
  errors: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        const topics = await fetchForumTopics(plugin.wpOrgSlug);
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
            },
          });
          result.newThreads += 1;
          state.newThreads += 1;
          newThreadIds.push(thread.id);
        }
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
        lastIndex: result.lastIndex,
        errors: result.errors,
      },
    });
    console.log(
      `[wporg] check ${result.status}: ${result.pluginsChecked} plugins, ${result.newThreads} new, ` +
        `${result.drafted} drafted, ${result.skippedOld} skipped (old), ${result.errors.length} error(s)`
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
