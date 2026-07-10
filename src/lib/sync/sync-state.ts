/**
 * In-memory progress for the currently running sync. Survives Next.js dev
 * hot reloads via globalThis. Durable history lives in the SyncLog table —
 * this singleton only powers live progress reporting and cancellation.
 */

export type SyncKind = "full" | "incremental" | "single";

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
}

export function requestSyncCancel(): boolean {
  const state = getSyncProgress();
  if (!state.running) return false;
  state.cancelRequested = true;
  return true;
}
