/**
 * In-memory progress for the currently running sync. Survives Next.js dev
 * hot reloads via globalThis. Durable history lives in the SyncLog table —
 * this singleton only powers live progress reporting and cancellation.
 */

export type SyncKind = "full" | "incremental" | "single" | "range";

/** Terminal status recorded when a run is halted on request. */
export type CancelReason = "cancelled" | "paused";

/**
 * Range-run verification, held in memory only (never a schema change). The
 * first real range run reports in-range counts by BOTH candidate bases so the
 * owner can tell which timestamp Crisp's date filter actually matches, plus the
 * requested window and whether the early-stop guard tripped.
 */
export interface RangeProgress {
  /** Requested window (ISO), shown on the running-progress line. */
  start: string | null;
  end: string | null;
  /** Conversations examined on processed pages (the verification denominator). */
  seen: number;
  /** In-range by updatedAtCrisp (last activity). */
  inByUpdated: number;
  /** In-range by createdAtCrisp. */
  inByCreated: number;
  /** The early-stop guard fired: an entire page fell outside the window. */
  stoppedEarly: boolean;
}

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
  /** Populated only for kind === "range" runs; otherwise all zero/null. */
  range: RangeProgress;
}

function freshRange(): RangeProgress {
  return {
    start: null,
    end: null,
    seen: 0,
    inByUpdated: 0,
    inByCreated: 0,
    stoppedEarly: false,
  };
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
    range: freshRange(),
  };
}

const globalForSync = globalThis as unknown as {
  crispSyncProgress?: SyncProgress;
};

export function getSyncProgress(): SyncProgress {
  globalForSync.crispSyncProgress ??= freshProgress();
  return globalForSync.crispSyncProgress;
}

export function beginSyncProgress(
  kind: SyncKind,
  syncLogId: string,
  range?: { start: Date; end: Date }
): SyncProgress {
  const state = getSyncProgress();
  Object.assign(state, freshProgress(), {
    running: true,
    kind,
    syncLogId,
    startedAt: new Date().toISOString(),
    statusMessage: "starting",
    range: {
      ...freshRange(),
      start: range?.start.toISOString() ?? null,
      end: range?.end.toISOString() ?? null,
    },
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
