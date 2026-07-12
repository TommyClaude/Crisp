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
  /**
   * FIFO queue of validated start requests waiting for the running sync to
   * finish (see enqueueSync below and the start route). Process-memory only,
   * like the rest of this singleton — lost on a server restart.
   */
  queue: QueueEntry[];
  /**
   * True when the queue is being held after a Stop/Pause rather than
   * auto-advancing (see the QueueState.held doc comment). Surfaced here so
   * the status route exposes it automatically.
   */
  held: boolean;
}

/**
 * One validated /api/sync/crisp/start request waiting behind the running
 * sync. Dates are kept as the original `YYYY-MM-DD` strings (not parsed
 * Dates) so a queued entry can replay through the exact same start path —
 * re-validated by validateRange at drain time — instead of carrying a
 * pre-resolved window that could drift from what the route would have
 * produced.
 */
export interface QueueEntry {
  id: string;
  kind: SyncKind;
  startPage?: number;
  /**
   * Scopes `startPage` to one brand (full/incremental only) — see the start
   * route's `startPageBrandId` validation. Re-applied at drain time by
   * resolveStartPages in sync-service.ts, same as a fresh request.
   */
  startPageBrandId?: string;
  /**
   * Full/incremental only — the run should resume every brand from its own
   * furthest page, derived FRESH from history at drain time (not frozen at
   * queue time) via getResumePages/resolveStartPages in sync-service.ts.
   */
  resume?: boolean;
  dateStart?: string;
  dateEnd?: string;
  brandId?: string;
  queuedAt: string;
}

/** FIFO cap — a 6th queued entry is rejected with a 409 (see enqueueSync). */
export const MAX_QUEUE_SIZE = 5;

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

/**
 * Everything a running sync resets on every new run. Deliberately excludes
 * `queue`/`held` — those live across run boundaries (a run starting or
 * ending must never clobber what's waiting behind it) and are merged in by
 * {@link getSyncProgress} instead.
 */
function freshProgress(): Omit<SyncProgress, "queue" | "held"> {
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
  const queueState = getQueueState();
  globalForSync.crispSyncProgress ??= {
    ...freshProgress(),
    queue: queueState.entries,
    held: queueState.held,
  };
  const state = globalForSync.crispSyncProgress;
  // Live references, not snapshots — mutations via enqueueSync/removeQueueEntry/
  // shiftQueueEntry/setQueueHeld are visible on the very next read without
  // needing to re-fetch this object.
  state.queue = queueState.entries;
  state.held = queueState.held;
  return state;
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
  // A freshly-started run's own outcome is what decides whether the queue
  // advances next (see QueueState.held) — whether this run was kicked off
  // manually or by the queue draining itself, "held" from some PRIOR run is
  // stale the moment a new run begins.
  setQueueHeld(false);
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

/**
 * In-memory FIFO sync queue — a second globalThis singleton alongside
 * crispSyncProgress (kept separate so a run starting/ending, which resets
 * most of SyncProgress via freshProgress(), can never accidentally clobber
 * what's queued behind it; see freshProgress's doc comment). Like sync
 * progress, this is process memory only: a server restart loses the queue,
 * same as it loses live progress of a running sync.
 */
interface QueueState {
  entries: QueueEntry[];
  /**
   * Set when a running sync ends by user intervention (Stop → "cancelled",
   * Pause → "paused") instead of ending naturally (completed/failed). While
   * held, the queue does not auto-advance — Stop/Pause expresses "I want
   * control now," and auto-launching more work would fight that. Cleared by
   * "Start next" (which also starts one entry) and by the very next run
   * beginning at all, from any source (see beginSyncProgress) — a fresh
   * run's own outcome is what decides whether the queue advances from there.
   */
  held: boolean;
}

function freshQueueState(): QueueState {
  return { entries: [], held: false };
}

const globalForQueue = globalThis as unknown as {
  crispSyncQueue?: QueueState;
};

function getQueueState(): QueueState {
  globalForQueue.crispSyncQueue ??= freshQueueState();
  return globalForQueue.crispSyncQueue;
}

/** The fields that define whether two queue requests are "the same sync". */
type QueueEntryKey = Pick<
  QueueEntry,
  | "kind"
  | "startPage"
  | "startPageBrandId"
  | "resume"
  | "dateStart"
  | "dateEnd"
  | "brandId"
>;

function sameQueueEntry(a: QueueEntryKey, b: QueueEntryKey): boolean {
  return (
    a.kind === b.kind &&
    a.startPage === b.startPage &&
    a.startPageBrandId === b.startPageBrandId &&
    a.resume === b.resume &&
    a.dateStart === b.dateStart &&
    a.dateEnd === b.dateEnd &&
    a.brandId === b.brandId
  );
}

export type EnqueueResult =
  | { ok: true; entry: QueueEntry; position: number }
  | { ok: false; reason: "duplicate" | "full" };

/**
 * Add a validated start request to the FIFO queue. Only meant to be called
 * once a sync is already running and every other start-route validation
 * (range/brandId/startPage rules) has already passed — this function itself
 * only enforces queue-specific rules:
 *
 *  - An exact duplicate of an ALREADY-QUEUED entry (same kind + startPage/
 *    startPageBrandId/resume/dateStart/dateEnd/brandId) is rejected
 *    ("duplicate"). A request that
 *    merely duplicates the currently-RUNNING sync is fine to queue —
 *    re-running is idempotent and sometimes intentional — so the running
 *    sync is deliberately not part of this comparison.
 *  - Once {@link MAX_QUEUE_SIZE} entries are queued, further entries are
 *    rejected ("full") — checked after the duplicate check, so re-submitting
 *    something already queued reports "duplicate" even when the queue also
 *    happens to be full.
 *
 * Returns the 1-based FIFO position on success (1 = starts right after the
 * current run).
 */
export function enqueueSync(input: QueueEntryKey): EnqueueResult {
  const state = getQueueState();
  if (state.entries.some((entry) => sameQueueEntry(entry, input))) {
    return { ok: false, reason: "duplicate" };
  }
  if (state.entries.length >= MAX_QUEUE_SIZE) {
    return { ok: false, reason: "full" };
  }
  const entry: QueueEntry = {
    kind: input.kind,
    startPage: input.startPage,
    startPageBrandId: input.startPageBrandId,
    resume: input.resume,
    dateStart: input.dateStart,
    dateEnd: input.dateEnd,
    brandId: input.brandId,
    id: crypto.randomUUID(),
    queuedAt: new Date().toISOString(),
  };
  state.entries.push(entry);
  return { ok: true, entry, position: state.entries.length };
}

/** Remove one queued entry by id. Returns false if no entry has that id. */
export function removeQueueEntry(id: string): boolean {
  const state = getQueueState();
  const index = state.entries.findIndex((entry) => entry.id === id);
  if (index === -1) return false;
  state.entries.splice(index, 1);
  return true;
}

/** Remove and return the next entry (FIFO order). */
export function shiftQueueEntry(): QueueEntry | undefined {
  return getQueueState().entries.shift();
}

export function isQueueHeld(): boolean {
  return getQueueState().held;
}

export function setQueueHeld(held: boolean): void {
  getQueueState().held = held;
}
