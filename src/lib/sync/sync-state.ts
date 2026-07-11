/**
 * In-memory progress for the currently running sync. Survives Next.js dev
 * hot reloads via globalThis. Durable history lives in the SyncLog table —
 * this singleton only powers live progress reporting and cancellation.
 */

export type SyncKind = "full" | "incremental" | "single";

/** Terminal status recorded when a run is halted on request. */
export type CancelReason = "cancelled" | "paused";

export interface SyncProgress {
  running: boolean;
  kind: SyncKind | null;
  syncLogId: string | null;
  currentPage: number | null;
  conversationsSynced: number;
  messagesSynced: number;
  failedSessions: string[];
  startedAt: string | null;
  lastSessionId: string | null;
  statusMessage: string | null;
  cancelRequested: boolean;
  /** Whether an in-flight halt should record the run as paused vs cancelled. */
  cancelReason: CancelReason;
}

function freshProgress(): SyncProgress {
  return {
    running: false,
    kind: null,
    syncLogId: null,
    currentPage: null,
    conversationsSynced: 0,
    messagesSynced: 0,
    failedSessions: [],
    startedAt: null,
    lastSessionId: null,
    statusMessage: null,
    cancelRequested: false,
    cancelReason: "cancelled",
  };
}

const globalForSync = globalThis as unknown as {
  crispSyncProgress?: SyncProgress;
};

export function getSyncProgress(): SyncProgress {
  globalForSync.crispSyncProgress ??= freshProgress();
  return globalForSync.crispSyncProgress;
}

export function beginSyncProgress(kind: SyncKind, syncLogId: string): SyncProgress {
  const state = getSyncProgress();
  Object.assign(state, freshProgress(), {
    running: true,
    kind,
    syncLogId,
    startedAt: new Date().toISOString(),
    statusMessage: "starting",
  });
  return state;
}

export function endSyncProgress(statusMessage: string): void {
  const state = getSyncProgress();
  state.running = false;
  state.statusMessage = statusMessage;
  state.cancelRequested = false;
  state.cancelReason = "cancelled";
}

/**
 * Request a graceful halt of the running sync. `reason` decides the terminal
 * status the run records: "cancelled" (Stop) or "paused" (Pause) — a paused
 * (or failed) run surfaces a "Continue" affordance in the UI, pre-filled with
 * the furthest page any run has reached.
 */
export function requestSyncCancel(reason: CancelReason = "cancelled"): boolean {
  const state = getSyncProgress();
  if (!state.running) return false;
  state.cancelRequested = true;
  state.cancelReason = reason;
  return true;
}
