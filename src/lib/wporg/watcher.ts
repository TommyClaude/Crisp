import { prisma } from "@/lib/db";
import { generateSuggestionForThread } from "@/lib/suggest/suggester";
import { fetchForumTopics } from "./feed";

/**
 * WordPress.org forum watcher: polls the support-forum feed of every plugin
 * that has a wpOrgSlug, stores new topics as SupportThread rows, and
 * (optionally) drafts reply suggestions for them. Designed to run from cron
 * (`npm run wporg:check`) or the /suggestions UI.
 */

export interface WatcherResult {
  pluginsChecked: number;
  newThreads: number;
  drafted: number;
  errors: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const globalForWatcher = globalThis as unknown as {
  wporgCheckRunning?: boolean;
};

export function isWatcherRunning(): boolean {
  return Boolean(globalForWatcher.wporgCheckRunning);
}

export async function checkPluginForums(options?: {
  /** Generate LLM drafts for newly found threads (default true). */
  withSuggestions?: boolean;
  /** Restrict the check to one plugin. */
  pluginId?: string;
}): Promise<WatcherResult> {
  if (globalForWatcher.wporgCheckRunning) {
    throw new Error("A forum check is already running");
  }
  globalForWatcher.wporgCheckRunning = true;

  const result: WatcherResult = {
    pluginsChecked: 0,
    newThreads: 0,
    drafted: 0,
    errors: [],
  };

  try {
    const plugins = await prisma.plugin.findMany({
      where: {
        wpOrgSlug: { not: null },
        ...(options?.pluginId ? { id: options.pluginId } : {}),
      },
      select: { id: true, name: true, wpOrgSlug: true },
      orderBy: { name: "asc" },
    });

    const newThreadIds: string[] = [];

    for (const plugin of plugins) {
      if (!plugin.wpOrgSlug) continue;
      result.pluginsChecked += 1;
      try {
        const topics = await fetchForumTopics(plugin.wpOrgSlug);
        for (const topic of topics) {
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
          newThreadIds.push(thread.id);
        }
      } catch (error) {
        const message = `${plugin.name}: ${error instanceof Error ? error.message : String(error)}`;
        console.error("Forum check failed for", message);
        result.errors.push(message);
      }
      // Be polite to wp.org between feeds.
      await sleep(500);
    }

    if (options?.withSuggestions ?? true) {
      for (const threadId of newThreadIds) {
        try {
          const suggestion = await generateSuggestionForThread(threadId);
          if (suggestion.draftAnswer) result.drafted += 1;
        } catch (error) {
          result.errors.push(
            `suggestion ${threadId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    return result;
  } finally {
    globalForWatcher.wporgCheckRunning = false;
  }
}
