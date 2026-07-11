/**
 * In-memory progress for the currently running full "rebuild all chunks" job.
 * Survives Next.js dev hot reloads via globalThis. This singleton is the
 * single-flight guard (its `running` flag returns the 409 for a second start)
 * and powers live progress reporting + graceful cancellation for the UI.
 *
 * Mirrors src/lib/sync/sync-state.ts (sync) and src/lib/suggest/bulk.ts (bulk
 * drafts): after a run ends the final counts stay readable with running=false
 * so a poller that missed the last tick can still summarize the outcome.
 */

/** Terminal status a full rebuild records; "idle"/"running" are transient. */
export type RebuildStatus =
  | "idle"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface RebuildProgress {
  running: boolean;
  /** Conversations in the resolved-state work list (the purge sweep is separate). */
  total: number;
  /** Conversations processed so far (advances one per conversation). */
  done: number;
  chunksCreated: number;
  skipped: number;
  purged: number;
  cancelRequested: boolean;
  status: RebuildStatus;
}

function freshProgress(): RebuildProgress {
  return {
    running: false,
    total: 0,
    done: 0,
    chunksCreated: 0,
    skipped: 0,
    purged: 0,
    cancelRequested: false,
    status: "idle",
  };
}

const globalForRebuild = globalThis as unknown as {
  ragRebuildProgress?: RebuildProgress;
};

function state(): RebuildProgress {
  globalForRebuild.ragRebuildProgress ??= freshProgress();
  return globalForRebuild.ragRebuildProgress;
}

/**
 * Snapshot of the current rebuild's progress. After a run completes the final
 * counts stick around (with running=false) so a poller that missed the last
 * tick can still report the summary; all zeros / "idle" before the first run.
 */
export function getRebuildProgress(): RebuildProgress {
  return { ...state() };
}

export function isRebuildRunning(): boolean {
  return state().running;
}

/**
 * Claim the single-flight guard and reset all counters for a new run. Returns
 * the LIVE state object so the caller can increment its counters in place.
 * Callers must guard with {@link isRebuildRunning} first — this always resets.
 */
export function beginRebuildProgress(): RebuildProgress {
  const s = state();
  Object.assign(s, freshProgress(), { running: true, status: "running" });
  return s;
}

/** Record the terminal status and release the guard. */
export function endRebuildProgress(
  status: "completed" | "cancelled" | "failed"
): void {
  const s = state();
  s.running = false;
  s.status = status;
  s.cancelRequested = false;
}

/**
 * Request a graceful halt of the running rebuild. The loop checks the flag
 * before starting each next conversation and stops cleanly, recording status
 * "cancelled". Returns false (no-op) when nothing is running.
 */
export function requestRebuildCancel(): boolean {
  const s = state();
  if (!s.running) return false;
  s.cancelRequested = true;
  return true;
}
