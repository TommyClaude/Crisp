import { prisma } from "@/lib/db";
import { generateSuggestionForThread, type DraftItem } from "./suggester";

/**
 * Bulk draft generator: finds support topics that have no draft text yet
 * (status new/drafted/failed) and runs the answer suggester over them
 * sequentially in the background. Follows the forum watcher's globalThis
 * singleton-guard pattern so at most one bulk run exists per process, and
 * the /suggestions UI can poll progress while it works.
 */

export interface BulkDraftProgress {
  running: boolean;
  total: number;
  done: number;
  drafted: number;
  failed: number;
}

interface BulkDraftState extends BulkDraftProgress {
  startedAt: string | null;
}

const globalForBulkDraft = globalThis as unknown as {
  wporgBulkDraftState?: BulkDraftState;
};

function state(): BulkDraftState {
  globalForBulkDraft.wporgBulkDraftState ??= {
    running: false,
    total: 0,
    done: 0,
    drafted: 0,
    failed: 0,
    startedAt: null,
  };
  return globalForBulkDraft.wporgBulkDraftState;
}

export function isBulkDraftRunning(): boolean {
  return state().running;
}

/**
 * Progress of the current bulk run. After a run completes the final counts
 * stick around (with running=false) so a poller that missed the last tick can
 * still report the summary; all zeros before the first run.
 */
export function getBulkDraftProgress(): BulkDraftProgress {
  const { running, total, done, drafted, failed } = state();
  return { running, total, done, drafted, failed };
}

/** True when no stored per-provider draft carries text. */
function hasNoDraftText(draftsJson: unknown): boolean {
  if (!Array.isArray(draftsJson)) return true;
  return !(draftsJson as DraftItem[]).some(
    (draft) => draft && typeof draft === "object" && draft.text
  );
}

/**
 * IDs of topics eligible for a bulk draft: reviewable status, no primary
 * draftAnswer, and no draftsJson entry with text. The cheap part (status +
 * draftAnswer) filters in SQL; draftsJson text is checked here because its
 * shape isn't queryable portably.
 */
export async function findDraftlessThreadIds(
  pluginId?: string
): Promise<string[]> {
  const candidates = await prisma.supportThread.findMany({
    where: {
      status: { in: ["new", "drafted", "failed"] },
      draftAnswer: null,
      ...(pluginId ? { pluginId } : {}),
    },
    select: { id: true, draftsJson: true },
    orderBy: { fetchedAt: "asc" },
  });
  return candidates
    .filter((thread) => hasNoDraftText(thread.draftsJson))
    .map((thread) => thread.id);
}

async function runBulkDraftLoop(threadIds: string[]): Promise<void> {
  const progress = state();
  try {
    for (const threadId of threadIds) {
      try {
        const result = await generateSuggestionForThread(threadId);
        if (result.draftAnswer) progress.drafted += 1;
        else if (result.status === "failed") progress.failed += 1;
      } catch (error) {
        console.error(`Bulk draft failed for topic ${threadId}:`, error);
        progress.failed += 1;
      } finally {
        progress.done += 1;
      }
    }
  } finally {
    progress.running = false;
  }
}

/**
 * Start a background bulk draft run. Returns the number of queued topics
 * (0 = nothing eligible, no run started). Throws when a run is already
 * active. The loop itself is fire-and-forget — callers respond immediately
 * and poll getBulkDraftProgress().
 */
export async function startBulkDraftRun(options?: {
  pluginId?: string;
}): Promise<{ queued: number }> {
  const progress = state();
  if (progress.running) {
    throw new Error("A bulk draft run is already running");
  }
  // Claim the guard before the (async) eligibility query so two concurrent
  // starts can't both launch a loop.
  progress.running = true;
  progress.total = 0;
  progress.done = 0;
  progress.drafted = 0;
  progress.failed = 0;
  progress.startedAt = new Date().toISOString();

  let threadIds: string[];
  try {
    threadIds = await findDraftlessThreadIds(options?.pluginId);
  } catch (error) {
    progress.running = false;
    throw error;
  }
  if (threadIds.length === 0) {
    progress.running = false;
    return { queued: 0 };
  }

  progress.total = threadIds.length;
  runBulkDraftLoop(threadIds).catch((error) =>
    console.error("Bulk draft loop crashed:", error)
  );
  return { queued: threadIds.length };
}
