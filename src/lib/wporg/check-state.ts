/**
 * In-memory progress for the currently running wp.org forum check. Survives
 * Next.js dev hot reloads via globalThis. Durable history lives in the
 * ForumCheckLog table — this singleton only powers live progress reporting,
 * pause/stop, and the last-check summary on /suggestions.
 *
 * Mirrors src/lib/sync/sync-state.ts.
 */

/** Which stage of a check is running: fetching feeds, or drafting replies. */
export type CheckPhase = "feeds" | "drafting";

/** Terminal status recorded when a run is halted on request. */
export type CheckHaltReason = "cancelled" | "paused";

export interface CheckProgress {
  running: boolean;
  phase: CheckPhase;
  /** ForumCheckLog row backing this run (null until it's created). */
  checkLogId: string | null;
  pluginsTotal: number;
  /** Plugins fully processed in THIS run (drives "n done"). */
  pluginsDone: number;
  /** 1-based index (alphabetical order) of the plugin being checked. */
  currentIndex: number | null;
  currentPlugin: string | null;
  /** Topics found in the current plugin's feed (null until fetched). */
  currentFeedTopics: number | null;
  newThreads: number;
  drafted: number;
  /** Threads processed in the drafting phase (denominator is draftsTotal). */
  draftsDone: number;
  /**
   * Threads queued for the drafting phase this run. Not the same as
   * newThreads: rows the fetch-before-create page check gated (resolved or
   * support-answered-last) are created but never queued, so a
   * draftsDone/newThreads fraction would stall below 1.
   */
  draftsTotal: number;
  skippedOld: number;
  /** Old topics resurfaced by a fresh customer reply this run. */
  resurfaced: number;
  /**
   * New-topic rows created this run that the fetch-before-create page check
   * found NOT actionable (already resolved on wp.org, or support answered
   * last) — stored, but never drafted or Slack-notified. Live-progress-only:
   * not a ForumCheckLog column (see WatcherResult.skippedHandled).
   */
  skippedHandled: number;
  startedAt: string | null;
  cancelRequested: boolean;
  /** Whether an in-flight halt records the run as paused vs cancelled. */
  cancelReason: CheckHaltReason;
}

function freshProgress(): CheckProgress {
  return {
    running: false,
    phase: "feeds",
    checkLogId: null,
    pluginsTotal: 0,
    pluginsDone: 0,
    currentIndex: null,
    currentPlugin: null,
    currentFeedTopics: null,
    newThreads: 0,
    drafted: 0,
    draftsDone: 0,
    draftsTotal: 0,
    skippedOld: 0,
    resurfaced: 0,
    skippedHandled: 0,
    startedAt: null,
    cancelRequested: false,
    cancelReason: "cancelled",
  };
}

const globalForCheck = globalThis as unknown as {
  wporgCheckProgress?: CheckProgress;
};

export function getCheckProgress(): CheckProgress {
  globalForCheck.wporgCheckProgress ??= freshProgress();
  return globalForCheck.wporgCheckProgress;
}

export function isCheckRunning(): boolean {
  return getCheckProgress().running;
}

/**
 * Claim the singleton for a new run and reset its counters. Synchronous, so a
 * concurrent start can't race in between the guard check and the claim (the
 * caller must have already verified {@link isCheckRunning} is false).
 */
export function beginCheckProgress(): CheckProgress {
  const state = getCheckProgress();
  Object.assign(state, freshProgress(), {
    running: true,
    startedAt: new Date().toISOString(),
  });
  return state;
}

/** Release the singleton once a run finishes (whether it completed or halted). */
export function endCheckProgress(): void {
  const state = getCheckProgress();
  state.running = false;
  state.cancelRequested = false;
  state.cancelReason = "cancelled";
}

/**
 * Request a graceful halt of the running check. `reason` decides the terminal
 * status: "cancelled" (Stop) or "paused" (Pause) — both halt between plugins;
 * a paused/cancelled/failed run surfaces a "Continue" affordance in the UI.
 * Returns false when nothing is running.
 */
export function requestCheckCancel(
  reason: CheckHaltReason = "cancelled"
): boolean {
  const state = getCheckProgress();
  if (!state.running) return false;
  state.cancelRequested = true;
  state.cancelReason = reason;
  return true;
}

/** The subset of ForumCheckLog columns {@link computeResumeIndex} needs. */
export interface ResumeIndexCandidate {
  lastIndex: number | null;
  status: string;
}

/**
 * Pure reduction over check history: the plugin index to Continue from — one
 * past the furthest 1-based index any past run fully processed, across ALL
 * history (not just the latest run). Runs that never processed a plugin
 * (lastIndex null) don't count, so a run that fails immediately can't drag the
 * resume point backwards. Returns 1 when nothing qualifies; never exceeds
 * `pluginCount` (a fully completed history suggests re-checking the last
 * plugin rather than an out-of-range index).
 */
export function computeResumeIndex(
  runs: ResumeIndexCandidate[],
  pluginCount: number
): number {
  let furthest = 0;
  for (const run of runs) {
    if (run.lastIndex != null && run.lastIndex > furthest) {
      furthest = run.lastIndex;
    }
  }
  return Math.min(furthest + 1, Math.max(pluginCount, 1));
}
