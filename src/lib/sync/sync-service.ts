import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getEnv } from "@/env";
import { CrispApiError, CrispClient } from "@/lib/crisp/client";
import type { CrispConversation, CrispMessage } from "@/lib/crisp/types";
import { classifyJunk } from "@/lib/crisp/junk";
import { rebuildChunksForConversation } from "@/lib/rag/rebuild";
import {
  conversationToColumns,
  extractFile,
  messageToColumns,
} from "./normalize";
import {
  beginSyncProgress,
  endSyncProgress,
  getSyncProgress,
  isQueueHeld,
  setQueueHeld,
  shiftQueueEntry,
  type QueueEntry,
  type SyncKind,
} from "./sync-state";
import {
  classifyRangePage,
  COVERAGE_BASIS_LABEL,
  shouldStopRangeWalk,
} from "./coverage";
import { autoDetectMissingBrands } from "./archive-start";
import { validateRange } from "./range";

/** One brand's page range within a single sync run, as recorded on SyncLog.brandPages. */
export interface BrandPageProgress {
  from: number;
  to: number;
  /**
   * Conversations synced during THIS brand's own walk (retry-pass successes
   * included). The per-brand made-progress rule in computeResumePages needs
   * this — the run-level conversationsSynced would let one brand's progress
   * poison a sibling brand's resume point (review finding).
   */
  synced: number;
}

/**
 * SyncLog.brandPages shape: per-brand page progress for one run, keyed by
 * `brandId ?? "default"` (same convention as archiveStartBrandKey in
 * archive-start.ts). See the column's doc comment in schema.prisma.
 */
export type BrandPagesMap = Record<string, BrandPageProgress>;

/**
 * Safely coerce a SyncLog row's `brandPages` JSON column (an `unknown` —
 * Prisma's JsonValue, or whatever a caller/test hands in) into a
 * BrandPagesMap, or null when absent/malformed/empty. Defensive because this
 * reads a JSON column with no runtime schema enforcement — a hand-rolled
 * value (or a future format change) must degrade to "no brandPages" rather
 * than throw.
 */
function parseBrandPages(value: unknown): BrandPagesMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: BrandPagesMap = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const from = (entry as { from?: unknown } | null)?.from;
    const to = (entry as { to?: unknown } | null)?.to;
    const synced = (entry as { synced?: unknown } | null)?.synced;
    if (typeof from === "number" && typeof to === "number") {
      result[key] = { from, to, synced: typeof synced === "number" ? synced : 0 };
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Upsert batch size for messages — keeps transactions small and memory flat. */
const MESSAGE_BATCH_SIZE = 50;
/** Safety cap on conversation list pages (30 conversations/page → 300k). */
const MAX_PAGES = 10_000;
/** Overlap window for incremental sync, to absorb clock skew. */
const INCREMENTAL_OVERLAP_MS = 60 * 60 * 1000;

export interface SyncRunResult {
  syncLogId: string;
  status: "completed" | "failed" | "cancelled" | "paused";
  conversationsSynced: number;
  messagesSynced: number;
  failedSessions: string[];
  error?: string;
  /**
   * Present only for range runs. Verification aid for deciding which timestamp
   * Crisp's date filter matches: in-range counts by BOTH candidate bases over
   * the same `seen` conversations, plus whether the early-stop guard fired.
   */
  range?: {
    seen: number;
    inByUpdated: number;
    inByCreated: number;
    stoppedEarly: boolean;
    note?: string;
  };
}

/** One Crisp website to sync — a Brand row, or the legacy env fallback. */
export interface SyncTarget {
  brandId: string | null;
  websiteId: string;
  name: string;
}

/**
 * A Crisp client for a target. Every brand authenticates with the same
 * global CRISP_IDENTIFIER/CRISP_KEY in .env (a Crisp Marketplace plugin
 * production token, installed on every brand's workspace) — there is no
 * per-brand credential to resolve.
 */
export function crispClientForTarget(): CrispClient {
  return new CrispClient();
}

/**
 * Websites to sync: every Brand in the database, or — when none are
 * configured yet — the legacy CRISP_WEBSITE_ID from .env.
 */
export async function getSyncTargets(): Promise<SyncTarget[]> {
  const brands = await prisma.brand.findMany({ orderBy: { createdAt: "asc" } });
  if (brands.length > 0) {
    return brands.map((brand) => ({
      brandId: brand.id,
      websiteId: brand.crispWebsiteId,
      name: brand.name,
    }));
  }
  const env = getEnv();
  if (env.CRISP_WEBSITE_ID) {
    console.warn(
      "[sync] No brands configured — falling back to CRISP_WEBSITE_ID from .env. " +
        "Add your brands (one per Crisp website) in /brands."
    );
    return [
      {
        brandId: null,
        websiteId: env.CRISP_WEBSITE_ID,
        name: "default",
      },
    ];
  }
  throw new Error(
    "Nothing to sync: add at least one brand in /brands (or set CRISP_WEBSITE_ID in .env)."
  );
}

/** Ensure an Operator row exists for a Crisp user id; returns crispUserId. */
async function ensureOperator(
  crispUserId: string,
  details?: { name?: string | null; email?: string | null; avatar?: string | null; raw?: unknown }
): Promise<string> {
  await prisma.operator.upsert({
    where: { crispUserId },
    create: {
      crispUserId,
      name: details?.name ?? null,
      email: details?.email ?? null,
      avatar: details?.avatar ?? null,
      rawJson: (details?.raw as object) ?? undefined,
    },
    update: {
      // Only overwrite with non-null values so a stub never erases details.
      ...(details?.name ? { name: details.name } : {}),
      ...(details?.email ? { email: details.email } : {}),
      ...(details?.avatar ? { avatar: details.avatar } : {}),
      ...(details?.raw ? { rawJson: details.raw as object } : {}),
    },
  });
  return crispUserId;
}

/** Best-effort import of the operator roster (non-fatal when unavailable). */
async function syncOperatorRoster(
  client: CrispClient,
  websiteId: string
): Promise<void> {
  const operators = await client.listOperators(websiteId);
  for (const entry of operators) {
    const details = entry.details ?? entry;
    if (!details.user_id) continue;
    const name =
      [details.first_name, details.last_name].filter(Boolean).join(" ") || null;
    await ensureOperator(details.user_id, {
      name,
      email: details.email ?? null,
      avatar: details.avatar ?? null,
      raw: entry,
    });
  }
}

/**
 * Upsert one conversation and all of its messages/files from Crisp payloads.
 * Returns the number of messages written.
 */
export async function syncConversationPayload(
  conversation: CrispConversation,
  messages: CrispMessage[],
  target?: Pick<SyncTarget, "brandId" | "websiteId">
): Promise<{ conversationId: string; messageCount: number; isJunk: boolean }> {
  const sessionId = conversation.session_id;
  if (!sessionId) throw new Error("Conversation payload missing session_id");

  const fallbackWebsiteId =
    target?.websiteId ?? getEnv().CRISP_WEBSITE_ID ?? "unknown";
  const { assignedCrispUserId, ...columns } = conversationToColumns(
    conversation,
    fallbackWebsiteId
  );

  // The assignment FK references Operator.crispUserId — make sure it exists.
  if (assignedCrispUserId) await ensureOperator(assignedCrispUserId);

  const dbConversation = await prisma.conversation.upsert({
    where: { sessionId },
    create: {
      sessionId,
      ...columns,
      brandId: target?.brandId ?? null,
      assignedOperatorId: assignedCrispUserId,
    },
    update: {
      ...columns,
      ...(target?.brandId ? { brandId: target.brandId } : {}),
      assignedOperatorId: assignedCrispUserId,
    },
  });

  // Upsert operators discovered in message payloads before messages
  // reference them.
  const seenOperators = new Set<string>();
  for (const message of messages) {
    const userId = message.user?.user_id;
    if (message.from === "operator" && userId && !seenOperators.has(userId)) {
      seenOperators.add(userId);
      await ensureOperator(userId, {
        name: message.user?.nickname ?? null,
        avatar: message.user?.avatar ?? null,
      });
    }
  }

  // Upsert messages in small transactional batches.
  const messageIdByKey = new Map<string, string>();
  for (let i = 0; i < messages.length; i += MESSAGE_BATCH_SIZE) {
    const batch = messages.slice(i, i + MESSAGE_BATCH_SIZE);
    const rows = await prisma.$transaction(
      batch.map((message) => {
        const columns = messageToColumns(message);
        return prisma.message.upsert({
          where: {
            sessionId_crispMessageId: {
              sessionId,
              crispMessageId: columns.crispMessageId,
            },
          },
          create: {
            conversationId: dbConversation.id,
            sessionId,
            ...columns,
          },
          update: {
            content: columns.content,
            contentJson: columns.contentJson,
            timestampCrisp: columns.timestampCrisp,
            rawJson: columns.rawJson,
          },
          select: { id: true, crispMessageId: true },
        });
      })
    );
    for (const row of rows) {
      if (row.crispMessageId) messageIdByKey.set(row.crispMessageId, row.id);
    }
  }

  // Rebuild attachment records from file-carrying messages.
  const fileRows = messages.flatMap((message) => {
    const file = extractFile(message);
    if (!file) return [];
    const key = messageIdByKey.get(
      messageToColumns(message).crispMessageId
    );
    return [
      {
        conversationId: dbConversation.id,
        messageId: key ?? null,
        sessionId,
        url: file.url as string,
        filename: file.name ?? null,
        mimeType: file.type ?? null,
        size: typeof file.size === "number" ? Math.trunc(file.size) : null,
        rawJson: file as object,
      },
    ];
  });
  await prisma.$transaction([
    prisma.conversationFile.deleteMany({
      where: { conversationId: dbConversation.id },
    }),
    ...(fileRows.length > 0
      ? [prisma.conversationFile.createMany({ data: fileRows })]
      : []),
  ]);

  // Junk classification (see src/lib/crisp/junk.ts). Runs on every sync so
  // automated noise never reaches the conversations list or the RAG index —
  // UNLESS a human has vetoed it (junkOverride), in which case the
  // auto-classifier stays out of the way entirely. Operator/customer counts
  // are derived from the payload we already hold (no extra query).
  let isJunk = dbConversation.isJunk;
  if (!dbConversation.junkOverride) {
    let operatorMessageCount = 0;
    let userMessageCount = 0;
    for (const message of messages) {
      // Private notes and events are not replies — same convention as the
      // chunker's isChunkableConversation. A junk notification an operator
      // merely annotated ("spam, ignore") must still count as never answered.
      if (message.type === "note" || message.type === "event") continue;
      if ((message.from ?? "user") === "operator") operatorMessageCount += 1;
      else userMessageCount += 1;
    }
    const classification = classifyJunk({
      visitorEmail: columns.visitorEmail ?? null,
      lastMessagePreview: columns.lastMessagePreview ?? null,
      operatorMessageCount,
      userMessageCount,
    });
    isJunk = classification.junk;
    if (
      classification.junk !== dbConversation.isJunk ||
      classification.reason !== dbConversation.junkReason
    ) {
      await prisma.conversation.update({
        where: { id: dbConversation.id },
        data: { isJunk: classification.junk, junkReason: classification.reason },
      });
      // Newly flagged junk → purge any chunks immediately so the AI stops
      // learning from it. Flipping to NOT junk never auto-rebuilds here — the
      // next rebuild/sync pass re-chunks it (a resolved conversation is
      // rebuilt below on this very run).
      if (classification.junk && !dbConversation.isJunk) {
        await prisma.embeddingChunk.deleteMany({
          where: { conversationId: dbConversation.id },
        });
      }
    }
  }

  return {
    conversationId: dbConversation.id,
    messageCount: messages.length,
    isJunk,
  };
}

/** Fetch + sync one conversation by session id (used by resync endpoint). */
export async function resyncConversation(sessionId: string): Promise<{
  conversationId: string;
  messageCount: number;
  chunksCreated: number;
}> {
  const targets = await getSyncTargets();

  // Resolve which website the session belongs to: a previously synced
  // conversation knows its brand; otherwise probe every configured target
  // (each with its own token).
  const existing = await prisma.conversation.findUnique({
    where: { sessionId },
    select: { brandId: true },
  });

  let target: SyncTarget | null = null;
  let client: CrispClient | null = null;
  let conversation: CrispConversation | null = null;

  const knownFirst = existing?.brandId
    ? [
        ...targets.filter((t) => t.brandId === existing.brandId),
        ...targets.filter((t) => t.brandId !== existing.brandId),
      ]
    : targets;

  // One client across the candidate probes — same token everywhere, and the
  // instance's inter-request pacing should span the whole probe sequence.
  const probeClient = crispClientForTarget();
  for (const candidate of knownFirst) {
    try {
      conversation = await probeClient.getConversation(
        candidate.websiteId,
        sessionId
      );
      target = candidate;
      client = probeClient;
      break;
    } catch (error) {
      if (error instanceof CrispApiError && error.status === 404) continue;
      throw error;
    }
  }
  if (!conversation || !target || !client) {
    throw new CrispApiError(
      `Conversation ${sessionId} not found on any configured Crisp website`,
      404,
      "resync"
    );
  }

  const messages = await client.getAllMessages(target.websiteId, sessionId);
  const result = await syncConversationPayload(conversation, messages, target);

  let chunksCreated = 0;
  try {
    const rebuild = await rebuildChunksForConversation(result.conversationId);
    chunksCreated = rebuild.chunksCreated;
  } catch (error) {
    console.warn(`Chunk rebuild failed for ${sessionId}:`, error);
  }
  return { ...result, chunksCreated };
}

interface RunSyncOptions {
  kind: SyncKind;
  /**
   * Legacy single-number resume: maps to the FIRST target's brand key only
   * (brands ordered by createdAt asc, same as getSyncTargets) — the original
   * "resumes the first brand only" behavior, kept working for CLI scripts
   * (`npm run sync:crisp -- --page=N`) and any other caller that has no
   * per-brand map to give. Ignored for kind "range" (see startPages below).
   * When both this and `startPages` are given, this still wins for the first
   * brand's key — `startPages` (built by resolveStartPages) never carries an
   * entry for that key in that combination, so there's no actual conflict in
   * practice.
   */
  startPage?: number;
  /**
   * Per-brand resume: each target's walk starts at `startPages[brandId ??
   * "default"] ?? 1`, independent of every other brand — see
   * computeResumePages/getResumePages for how the suggested map is derived.
   * Ignored for kind "range": range page numbers index Crisp's date-filtered
   * list, a different numbering space, and a range walk always starts every
   * scoped brand at page 1.
   */
  startPages?: Record<string, number>;
  /** Only sync conversations updated at/after this time (incremental). */
  updatedSince?: Date | null;
  /**
   * Range mode (kind "range"): page-walk with Crisp's date filter applied and
   * a per-page early-stop guard. Both bounds are required together.
   */
  dateStart?: Date;
  dateEnd?: Date;
  /**
   * Scope the run to ONE brand instead of every configured target. Only
   * meaningful for kind "range" — full/incremental runs always cover every
   * brand and must never set this (callers enforce that; see runFullSync /
   * runIncrementalSync, whose public options have no brandId at all). An
   * unknown brandId (no matching Brand row) fails the run with a clear error,
   * same as the "nothing to sync" failure below — both surface as a `failed`
   * SyncLog rather than a thrown rejection, so every attempted run leaves a
   * history row.
   */
  brandId?: string;
}

/**
 * Grace window before {@link reconcileStaleSyncRuns} closes an orphaned
 * "running" SyncLog row. Long enough that a cron/CLI incremental sync in a
 * SEPARATE process (which this process cannot see) normally finishes inside
 * it; short enough that a restart-orphaned row heals on the next dashboard
 * poll instead of blocking syncs for hours.
 */
const RECONCILE_GRACE_MS = 10 * 60 * 1000;

/**
 * Close out "running" SyncLog rows that no longer correspond to a live run.
 * Sync progress lives in process memory, so a server restart (or crash) kills
 * an in-flight run without ever closing its log row — the row then reads
 * "running" forever, and the DB single-flight guard in {@link runSync} would
 * refuse new syncs until the 6-hour staleness window passed. Called from the
 * status route (the dashboard polls it) and before that guard, so an orphan
 * heals on the next dashboard view or start attempt. The synced data itself
 * is never affected — every write was an upsert that already committed.
 *
 * Caveat, documented on purpose: a genuinely-running CLI backfill in another
 * process that has been going longer than the grace window is
 * indistinguishable from an orphan here and gets its row closed early. The
 * CLI run itself keeps working and overwrites the row with its real final
 * status when it ends; the only cost is that the guard would let a dashboard
 * sync start alongside it (safe for data — upserts — just slower, as both
 * share the rate limit).
 */
export async function reconcileStaleSyncRuns(): Promise<number> {
  if (getSyncProgress().running) return 0;
  const graceBefore = new Date(Date.now() - RECONCILE_GRACE_MS);
  const result = await prisma.syncLog.updateMany({
    where: { status: "running", startedAt: { lt: graceBefore } },
    data: {
      status: "failed",
      finishedAt: new Date(),
      error:
        "Interrupted: the server restarted (or the process died) while this run was in flight. " +
        "Everything synced up to that point is saved — use Continue or a range sync to pick up where it left off.",
    },
  });
  return result.count;
}

/**
 * Core page-by-page sync loop. Progress is persisted to SyncLog after every
 * page, so an interrupted run can be resumed with `startPage`.
 */
async function runSync(options: RunSyncOptions): Promise<SyncRunResult> {
  const progress = getSyncProgress();
  if (progress.running) {
    throw new Error("A sync is already running");
  }

  // Heal restart-orphaned rows first so they can't trip the guard below.
  await reconcileStaleSyncRuns();

  // DB-level single-flight guard: the in-memory flag above only protects one
  // process; a CLI run and the web app (or two app instances) share the DB.
  // After reconciliation this only sees rows younger than the grace window —
  // i.e. a run that started moments ago in another process.
  const staleBefore = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const activeRun = await prisma.syncLog.findFirst({
    where: { status: "running", startedAt: { gte: staleBefore } },
    select: { id: true, startedAt: true },
  });
  if (activeRun) {
    throw new Error(
      `A sync appears to be running already (SyncLog ${activeRun.id}, started ${activeRun.startedAt.toISOString()}). ` +
        "If that run crashed, mark it failed or wait for it to be considered stale."
    );
  }

  const syncLog = await prisma.syncLog.create({
    data: {
      kind: options.kind,
      status: "running",
      // Range walks always start at page 1 of the filtered list — an ignored
      // legacy startPage must not be recorded as if it took effect.
      pageFrom: options.kind === "range" ? 1 : (options.startPage ?? 1),
      brandId: options.brandId ?? null,
    },
  });

  // Per-brand page progress accumulated over the WHOLE run (see
  // SyncLog.brandPages) — persisted alongside pageTo at the same cadence, one
  // entry per brand the walk has reached so far. Declared OUTSIDE the try so
  // the final SyncLog update (which persists retry-pass increments) can read
  // it on every exit path.
  const brandPages: BrandPagesMap = {};
  // Range window: both bounds or neither (callers guarantee this).
  const rangeWindow =
    options.dateStart && options.dateEnd
      ? { start: options.dateStart, end: options.dateEnd }
      : null;
  const state = beginSyncProgress(
    options.kind,
    syncLog.id,
    rangeWindow ?? undefined
  );

  const updatedSinceMs = options.updatedSince?.getTime() ?? null;
  let status: SyncRunResult["status"] = "completed";
  let errorMessage: string | undefined;
  // Human note when the early-stop guard trips (surfaced in the result).
  let rangeStoppedNote: string | undefined;

  try {
    const allTargets = await getSyncTargets();
    // Brand-scoped range sync: narrow the walk to the one requested brand.
    // Full/incremental never set brandId (see the RunSyncOptions doc comment),
    // so this filter is a no-op for them. An id that matches no configured
    // Brand fails the run with a clear message rather than silently walking
    // every brand — caught below like any other failure, so it still leaves
    // a `failed` SyncLog (with the requested brandId already on the row) for
    // the owner to see, instead of a bare rejected promise.
    const targets = options.brandId
      ? allTargets.filter((target) => target.brandId === options.brandId)
      : allTargets;
    if (options.brandId && targets.length === 0) {
      throw new Error(
        `Unknown brand: ${options.brandId} — no configured Brand has this id.`
      );
    }
    // Remember which website a failed session belongs to for the retry pass,
    // and reuse one client per brand so each brand's requests queue and rate
    // limit independently.
    const failedTargets = new Map<string, SyncTarget>();
    // Every brand authenticates with the same global token, so one shared
    // client for the whole run keeps a single request queue and a single
    // inter-request pacing state — no burst at brand boundaries.
    let sharedClient: CrispClient | null = null;
    const clientFor = (): CrispClient => {
      sharedClient ??= crispClientForTarget();
      return sharedClient;
    };

    // Auto-detect archive start (see coverage.ts / archive-start.ts) on
    // EVERY full sync — including one resumed via startPage, since brands
    // after the first always walk from page 1 anyway and the probes are
    // independent of the page walk entirely. Only brands missing an entry
    // are probed (~8-10 requests each, negligible next to a full backfill;
    // zero requests once every brand is detected) and existing entries are
    // merged, not replaced — a brand added later gets filled in on its next
    // full sync too. Incremental/range runs never probe: they're routine or
    // narrowly scoped, not archive-maintenance moments. Never fatal: the
    // manual "Detect archive start" button on the dashboard remains the
    // retry path if this fails.
    if (options.kind === "full") {
      state.statusMessage = "detecting archive start";
      try {
        await autoDetectMissingBrands(targets, clientFor());
      } catch (error) {
        console.warn(
          "Archive-start auto-detect failed (non-fatal, sync continues):",
          error
        );
      }
    }

    // Resolve the effective per-brand starting page for this run. Range mode
    // ignores both startPage and startPages entirely — a range walk always
    // starts every scoped brand at page 1 (its page numbers index Crisp's
    // date-filtered list, a different numbering space; see computeResumePage/
    // computeResumePages for the same exclusion on the read side).
    const effectiveStartPages: Record<string, number> =
      options.kind === "range" ? {} : { ...(options.startPages ?? {}) };
    if (options.kind !== "range" && options.startPage != null && targets[0]) {
      // Legacy startPage resumes the FIRST brand only, same as before
      // per-brand resume existed.
      effectiveStartPages[targets[0].brandId ?? "default"] = options.startPage;
    }
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t];
      if (state.cancelRequested) {
        status = state.cancelReason;
        break;
      }

      let client: CrispClient;
      try {
        client = clientFor();
      } catch (error) {
        // Missing/invalid token for this brand — skip it, don't abort others.
        const message = `${target.name}: ${error instanceof Error ? error.message : String(error)}`;
        console.error("Skipping brand without a usable Crisp token:", message);
        state.failedSessions.push(`brand:${target.name}`);
        continue;
      }

      try {
        await syncOperatorRoster(client, target.websiteId);
      } catch (error) {
        console.warn(
          `Operator roster sync failed for ${target.name} (non-fatal):`,
          error
        );
      }

      // Each brand resumes independently from its own entry in
      // effectiveStartPages (see above) — defaulting to page 1 for a brand
      // with no resume entry at all.
      const brandKey = target.brandId ?? "default";
      // This brand's own synced count for the run — see BrandPageProgress.synced.
      let brandSynced = 0;
      let page = effectiveStartPages[brandKey] ?? 1;
      const brandStartPage = page;
      let reachedCheckpoint = false;

      while (page < MAX_PAGES && !reachedCheckpoint) {
        if (state.cancelRequested) {
          status = state.cancelReason;
          break;
        }

        state.currentPage = page;
        state.statusMessage = `[${target.name}] fetching page ${page}`;
        const conversations = await client.listConversations(
          target.websiteId,
          page,
          rangeWindow
            ? { dateStart: rangeWindow.start, dateEnd: rangeWindow.end }
            : undefined
        );
        if (!conversations || conversations.length === 0) break;

        // Range mode SAFETY GUARD: classify the page by the coverage basis and
        // stop this target's walk if the WHOLE page landed outside the window —
        // a wrongly-ignored Crisp filter must never degenerate into a full
        // walk. Verification counts (by both bases) accumulate only for pages
        // we actually process, so a bailed-out page's out-of-range noise never
        // pollutes the "which basis does the filter use?" signal.
        if (rangeWindow) {
          const stats = classifyRangePage(conversations, rangeWindow);
          if (shouldStopRangeWalk(stats)) {
            state.range.stoppedEarly = true;
            rangeStoppedNote =
              `Stopped early on page ${page}: an entire page fell outside the ` +
              `requested range — Crisp's date filter appears to be ignored or ` +
              `the range is exhausted. ${stats.basisOut} of ${stats.seen} ` +
              `conversations were out of range by ${COVERAGE_BASIS_LABEL}, none in.`;
            state.statusMessage = `[${target.name}] ${rangeStoppedNote}`;
            break;
          }
          state.range.seen += stats.seen;
          state.range.inByUpdated += stats.inByUpdated;
          state.range.inByCreated += stats.inByCreated;
        }

        // Incremental mode: the list is roughly newest-activity-first, but
        // Crisp's sort key (activity) is not identical to updated_at, so a
        // single stale conversation must not end the run. Instead, skip stale
        // conversations individually and stop once an ENTIRE page is stale.
        let sawFreshConversation = false;

        for (const conversation of conversations) {
          if (state.cancelRequested) {
            status = state.cancelReason;
            break;
          }
          const sessionId = conversation.session_id;
          if (!sessionId) continue;

          if (
            updatedSinceMs !== null &&
            typeof conversation.updated_at === "number" &&
            conversation.updated_at < updatedSinceMs
          ) {
            continue;
          }
          sawFreshConversation = true;

          state.lastSessionId = sessionId;
          state.statusMessage = `[${target.name}] syncing ${sessionId} (page ${page})`;
          try {
            const messages = await client.getAllMessages(
              target.websiteId,
              sessionId
            );
            const result = await syncConversationPayload(
              conversation,
              messages,
              target
            );
            state.conversationsSynced += 1;
            brandSynced += 1;
            state.messagesSynced += result.messageCount;

            // Junk conversations are excluded from chunk rebuilding — they
            // were already purged from the index above (if they just flipped
            // to junk) and must never re-enter it.
            if (conversation.state === "resolved" && !result.isJunk) {
              try {
                await rebuildChunksForConversation(result.conversationId);
              } catch (error) {
                console.warn(`Chunk rebuild failed for ${sessionId}:`, error);
              }
            }
          } catch (error) {
            console.error(`Failed to sync conversation ${sessionId}:`, error);
            state.failedSessions.push(sessionId);
            failedTargets.set(sessionId, target);
          }
        }

        // Persist page-level progress so the run is resumable. brandPages
        // records THIS brand's own range (unaffected by whatever other
        // brands did earlier in the run) alongside the legacy global pageTo
        // (still whichever brand is currently walking — unchanged meaning).
        brandPages[brandKey] = { from: brandStartPage, to: page, synced: brandSynced };
        await prisma.syncLog.update({
          where: { id: syncLog.id },
          data: {
            pageTo: page,
            brandPages: brandPages as unknown as Prisma.InputJsonValue,
            conversationsSynced: state.conversationsSynced,
            messagesSynced: state.messagesSynced,
            failedSessions: state.failedSessions,
          },
        });
        if (updatedSinceMs !== null && !sawFreshConversation) {
          reachedCheckpoint = true;
        }
        page += 1;
      }
    }

    // Retry pass: transient per-conversation failures usually heal on a
    // second attempt. Anything that still fails downgrades the run to
    // "failed" so the incremental checkpoint does not advance past it —
    // otherwise a conversation that never gets touched again would be
    // permanently missing from the archive.
    if (status === "completed" && state.failedSessions.length > 0) {
      const stillFailed: string[] = [];
      for (const sessionId of state.failedSessions) {
        if (state.cancelRequested) {
          stillFailed.push(sessionId);
          continue;
        }
        const target = failedTargets.get(sessionId);
        if (!target) {
          stillFailed.push(sessionId);
          continue;
        }
        state.statusMessage = `retrying failed conversation ${sessionId}`;
        try {
          const client = clientFor();
          const conversation = await client.getConversation(
            target.websiteId,
            sessionId
          );
          const messages = await client.getAllMessages(
            target.websiteId,
            sessionId
          );
          const result = await syncConversationPayload(
            conversation,
            messages,
            target
          );
          state.conversationsSynced += 1;
          state.messagesSynced += result.messageCount;
          // A retry success is progress for ITS brand's walk, too.
          const retryEntry = brandPages[target.brandId ?? "default"];
          if (retryEntry) retryEntry.synced += 1;
          // Junk conversations never re-enter the RAG index (see the main loop).
          if (conversation.state === "resolved" && !result.isJunk) {
            try {
              await rebuildChunksForConversation(result.conversationId);
            } catch (error) {
              console.warn(`Chunk rebuild failed for ${sessionId}:`, error);
            }
          }
        } catch (error) {
          console.error(`Retry failed for conversation ${sessionId}:`, error);
          stillFailed.push(sessionId);
        }
      }
      state.failedSessions = stillFailed;
      if (stillFailed.length > 0) {
        status = "failed";
        errorMessage =
          `${stillFailed.length} conversation(s) failed after retry; ` +
          "the incremental checkpoint was not advanced. See failedSessions.";
      }
    }
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Sync run failed:", error);
  }

  await prisma.syncLog.update({
    where: { id: syncLog.id },
    data: {
      status,
      finishedAt: new Date(),
      conversationsSynced: state.conversationsSynced,
      messagesSynced: state.messagesSynced,
      failedSessions: state.failedSessions,
      // Re-persist so retry-pass increments to per-brand synced counts land.
      ...(Object.keys(brandPages).length > 0
        ? { brandPages: brandPages as unknown as Prisma.InputJsonValue }
        : {}),
      error: errorMessage ?? null,
    },
  });
  endSyncProgress(status);

  return {
    syncLogId: syncLog.id,
    status,
    conversationsSynced: state.conversationsSynced,
    messagesSynced: state.messagesSynced,
    failedSessions: state.failedSessions,
    error: errorMessage,
    ...(rangeWindow
      ? {
          range: {
            seen: state.range.seen,
            inByUpdated: state.range.inByUpdated,
            inByCreated: state.range.inByCreated,
            stoppedEarly: state.range.stoppedEarly,
            note: rangeStoppedNote,
          },
        }
      : {}),
  };
}

/** The subset of SyncLog columns {@link computeResumePage}/{@link computeResumePages} need. */
export interface ResumeCandidate {
  kind: string;
  pageFrom: number | null;
  pageTo: number | null;
  conversationsSynced: number;
  /** Per-brand page progress for this run (see SyncLog.brandPages) — absent/null on legacy rows and any row written before this feature. */
  brandPages?: unknown;
}

/**
 * Pure reduction over sync history: the furthest page any run reached, across
 * ALL of history — not just the latest run. A run only counts if it made
 * progress: it synced at least one conversation, or its pageTo advanced past
 * its own pageFrom. Runs that failed at their own starting page with nothing
 * synced are ignored, so a fresh run that dies immediately (e.g. a bad token)
 * can never drag the suggestion backwards. Range runs are excluded entirely:
 * their page numbers index Crisp's date-FILTERED list — a different numbering
 * space from the full archive walk — so "page 50" of a range run must never
 * become the resume suggestion for a full/incremental run (continuing from it
 * would silently skip real archive pages). Matches the existing "continue"
 * convention of using pageTo directly as the next startPage (the loop in
 * runSync re-processes that page, which is idempotent via upserts) — callers
 * should NOT add 1 to the result. Falls back to 1 when nothing qualifies.
 */
export function computeResumePage(runs: ResumeCandidate[]): number {
  let furthest = 0;
  for (const run of runs) {
    if (run.kind === "range") continue;
    const pageTo = run.pageTo ?? 0;
    const pageFrom = run.pageFrom ?? 1;
    const madeProgress = run.conversationsSynced > 0 || pageTo > pageFrom;
    if (madeProgress && pageTo > furthest) furthest = pageTo;
  }
  return Math.max(furthest, 1);
}

/**
 * The default "Continue" resume point, derived from all SyncLog history (see
 * {@link computeResumePage}).
 */
export async function getResumePage(): Promise<number> {
  // No pageTo/kind filter here — computeResumePage() handles both, and keeping
  // the progress rules in one place avoids a silent SQL/JS logic split.
  const runs = await prisma.syncLog.findMany({
    where: { status: { not: "running" } },
    select: { kind: true, pageFrom: true, pageTo: true, conversationsSynced: true },
  });
  return computeResumePage(runs);
}

/**
 * Pure per-brand reduction over sync history — the per-brand counterpart to
 * {@link computeResumePage}. For each key in `orderedBrandKeys` (brands
 * ordered by createdAt asc — the same "first brand" convention runSync's
 * legacy `startPage` handling has always used; falls back to `["default"]`
 * when empty, matching the legacy env-only fallback target), returns the
 * furthest page any run's walk of THAT brand reached, across all of history.
 *
 * Same made-progress rule as computeResumePage (conversationsSynced > 0 || to
 * > from) — applied PER BRAND for a run that recorded `brandPages` (using
 * that brand's own `to`/`from`; `conversationsSynced` is only tracked at the
 * whole-run level, so it's reused as-is for every brand the run touched).
 * Range runs are excluded entirely, same reasoning as computeResumePage:
 * their page numbers index Crisp's date-filtered list, a different numbering
 * space. Legacy rows — pageTo set but no brandPages, from before this column
 * existed — count toward the FIRST brand key only, matching the
 * first-brand-only semantics those runs actually had. Falls back to 1 for
 * any brand with no qualifying history.
 *
 * Pure — takes the ordered brand keys as a parameter instead of querying
 * Brand itself, so it stays testable without a database (see
 * {@link getResumePages} for the DB-backed wrapper).
 */
export function computeResumePages(
  runs: ResumeCandidate[],
  orderedBrandKeys: string[]
): Record<string, number> {
  const keys = orderedBrandKeys.length > 0 ? orderedBrandKeys : ["default"];
  const firstKey = keys[0];
  const furthest: Record<string, number> = {};
  const bump = (key: string, page: number) => {
    if (page > (furthest[key] ?? 0)) furthest[key] = page;
  };

  for (const run of runs) {
    if (run.kind === "range") continue;
    const brandPages = parseBrandPages(run.brandPages);
    if (brandPages) {
      for (const [key, { from, to, synced }] of Object.entries(brandPages)) {
        // The brand's OWN progress only — the run-level conversationsSynced
        // would let brand A's progress mark brand B's stalled walk as
        // progressed and silently skip B's pages (review finding).
        const madeProgress = synced > 0 || to > from;
        if (madeProgress) bump(key, to);
      }
      continue;
    }
    const pageTo = run.pageTo ?? 0;
    const pageFrom = run.pageFrom ?? 1;
    const madeProgress = run.conversationsSynced > 0 || pageTo > pageFrom;
    if (madeProgress) bump(firstKey, pageTo);
  }

  const result: Record<string, number> = {};
  for (const key of keys) {
    result[key] = Math.max(furthest[key] ?? 0, 1);
  }
  return result;
}

/**
 * Brand keys in the order runSync/getSyncTargets walks them (createdAt asc),
 * for the "first brand" convention legacy startPage handling relies on.
 * `["default"]` for the legacy env-only fallback (no Brand rows at all) —
 * matching getSyncTargets' own fallback target.
 */
async function getOrderedBrandKeys(): Promise<string[]> {
  const brands = await prisma.brand.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return brands.length > 0 ? brands.map((brand) => brand.id) : ["default"];
}

/**
 * The per-brand "Continue" resume point (see {@link computeResumePages}) —
 * each configured brand's own furthest page across all history, independent
 * of the others. Object key order matches `orderedBrandKeys` (createdAt asc),
 * so `Object.keys(result)[0]` is always the "first brand" — relied on by the
 * dashboard's default (no `?brand=` selected) prefill.
 */
export async function getResumePages(): Promise<Record<string, number>> {
  const [orderedBrandKeys, runs] = await Promise.all([
    getOrderedBrandKeys(),
    prisma.syncLog.findMany({
      where: { status: { not: "running" } },
      select: {
        kind: true,
        pageFrom: true,
        pageTo: true,
        conversationsSynced: true,
        brandPages: true,
      },
    }),
  ]);
  return computeResumePages(runs, orderedBrandKeys);
}

/**
 * Resolve the final startPage/startPages to hand to runFullSync/
 * runIncrementalSync, given a validated `resume`/`startPage`/
 * `startPageBrandId` combination (see the start route's body schema — this
 * assumes that validation already ran). `resume` derives a FRESH per-brand
 * map from current history (see getResumePages) at the moment this is
 * called — deliberately re-derived rather than resolved once upfront, so a
 * QUEUED resume entry (see startQueuedEntry) reflects everything synced
 * while it waited, not a stale snapshot from when it was queued. `startPage`,
 * when given, overrides ONE brand's derived page: `startPageBrandId` if set,
 * else the first brand (createdAt asc) — the same "first brand" convention
 * runSync's legacy startPage handling has always used.
 *
 * When neither `resume` nor `startPageBrandId` is set, this is a pure
 * pass-through of `startPage` with no extra DB query — the common, unchanged
 * "resume the first brand by number" case behaves exactly as it did before
 * per-brand resume existed. Shared by the start route (fresh requests) and
 * startQueuedEntry (queued replays) so both compute the exact same thing the
 * exact same way.
 */
export async function resolveStartPages(options: {
  resume?: boolean;
  startPage?: number;
  startPageBrandId?: string;
}): Promise<{ startPage?: number; startPages?: Record<string, number> }> {
  if (!options.resume && options.startPageBrandId == null) {
    return { startPage: options.startPage };
  }
  const startPages: Record<string, number> = options.resume
    ? await getResumePages()
    : {};
  if (options.startPage != null) {
    const key = options.startPageBrandId ?? (await getOrderedBrandKeys())[0];
    startPages[key] = options.startPage;
  }
  return { startPages };
}

/** Full sync of all conversations, oldest data included. Resumable via startPage/startPages. */
export function runFullSync(options?: {
  startPage?: number;
  startPages?: Record<string, number>;
}): Promise<SyncRunResult> {
  return runSync({
    kind: "full",
    startPage: options?.startPage,
    startPages: options?.startPages,
  });
}

/**
 * Range sync: page-walk WITH Crisp's `filter_date_*` params applied, upserting
 * as usual, guarded so a fully-out-of-range page stops the walk early (see the
 * guard in {@link runSync}). Lets the owner refill a specific gap the coverage
 * heatmap surfaced without spending quota on a full backfill. The window is
 * inclusive and interpreted exactly as passed (callers build a UTC day window).
 *
 * `brandId`, when given, scopes the walk to that one brand instead of every
 * configured target and is written onto the resulting SyncLog row (see
 * runSync's brandId handling) — an unknown id fails the run with a clear
 * error. Full/incremental syncs have no such option; only a range sync can be
 * scoped to one brand.
 */
export function runRangeSync(options: {
  dateStart: Date;
  dateEnd: Date;
  startPage?: number;
  brandId?: string;
}): Promise<SyncRunResult> {
  return runSync({
    kind: "range",
    dateStart: options.dateStart,
    dateEnd: options.dateEnd,
    startPage: options.startPage,
    brandId: options.brandId,
  });
}

/**
 * Incremental sync: only conversations updated since the last successful run
 * (with a one-hour overlap). Falls back to a full sync when no successful
 * run exists yet.
 */
export async function runIncrementalSync(options?: {
  startPage?: number;
  startPages?: Record<string, number>;
}): Promise<SyncRunResult> {
  const lastSuccess = await prisma.syncLog.findFirst({
    where: { status: "completed", kind: { in: ["full", "incremental"] } },
    orderBy: { startedAt: "desc" },
  });
  if (!lastSuccess) {
    return runSync({
      kind: "full",
      startPage: options?.startPage,
      startPages: options?.startPages,
    });
  }
  const updatedSince = new Date(
    lastSuccess.startedAt.getTime() - INCREMENTAL_OVERLAP_MS
  );
  return runSync({
    kind: "incremental",
    updatedSince,
    startPage: options?.startPage,
    startPages: options?.startPages,
  });
}

/**
 * Replay one queued entry through the exact same run functions the start
 * route uses. The date window is re-validated from the entry's original
 * `YYYY-MM-DD` strings (see QueueEntry's doc comment) rather than trusting a
 * pre-resolved window — cheap, and it means a queued range entry always goes
 * through the identical validation path a fresh request would.
 *
 * An unknown/deleted brandId is NOT handled here — it flows into
 * runRangeSync exactly like a fresh request would, which fails the run with
 * a clear error and still records a `failed` SyncLog (see runSync's brandId
 * handling), so a queued entry gone stale while waiting never wedges the
 * queue: {@link advanceQueueAfter} sees the `failed` status and drains the
 * next entry regardless.
 *
 * A queued `resume` entry re-derives its startPages map at DRAIN time via
 * {@link resolveStartPages} (not once when it was queued) — see that
 * function's doc comment for why that's the correct behavior for a request
 * that may have waited behind other syncs.
 */
async function startQueuedEntry(entry: QueueEntry): Promise<SyncRunResult> {
  if (entry.kind === "range") {
    const check = validateRange(entry.dateStart, entry.dateEnd);
    if (check.ok && check.window) {
      return runRangeSync({
        dateStart: check.window.start,
        dateEnd: check.window.end,
        brandId: entry.brandId,
      });
    }
    // Unreachable in practice — dateStart/dateEnd were already validated by
    // the start route before this entry was queued, and plain strings don't
    // go stale while sitting in the queue. Guarded anyway so a queue entry
    // can never wedge the drain chain: report it as a failed run (no SyncLog
    // row, since runSync/runRangeSync was never actually invoked) instead of
    // throwing out of the chain.
    console.error(
      `Queued range entry ${entry.id} failed re-validation: ${
        check.ok ? "window missing" : check.message
      }`
    );
    return {
      syncLogId: "",
      status: "failed",
      conversationsSynced: 0,
      messagesSynced: 0,
      failedSessions: [],
      error: check.ok ? "Range window missing on replay" : check.message,
    };
  }
  const resolved = await resolveStartPages({
    resume: entry.resume,
    startPage: entry.startPage,
    startPageBrandId: entry.startPageBrandId,
  });
  if (entry.kind === "incremental") {
    return runIncrementalSync(resolved);
  }
  return runFullSync(resolved);
}

/**
 * Drain one entry off the queue and start it, chaining {@link advanceQueueAfter}
 * onto the resulting run so the chain continues after IT settles too. A
 * no-op if a sync is already running, the queue is held, or the queue is
 * empty — callers don't need to check those themselves.
 */
function drainNextQueuedSync(): void {
  if (getSyncProgress().running || isQueueHeld()) return;
  const next = shiftQueueEntry();
  if (!next) return;
  // Fire-and-forget, like the start route's own run.catch(...) — this chain
  // drives SyncLog + in-memory progress itself; nothing here needs to be
  // awaited by the caller.
  void advanceQueueAfter(startQueuedEntry(next)).catch((error) =>
    console.error(`Queued sync (${next.kind}) failed to start:`, error)
  );
}

/**
 * Wrap a run promise (from runFullSync/runIncrementalSync/runRangeSync) so
 * that once it settles, the queue reacts correctly:
 *
 *  - Natural end (completed/failed) → auto-advance: drain and start the next
 *    queued entry, if any. A queued entry that fails (e.g. its brand was
 *    deleted while it waited) still records its own `failed` SyncLog via the
 *    normal runSync path and this same branch drains past it — no wedged
 *    queue.
 *  - Halted by the user (cancelled/paused) → HOLD: set the held flag and
 *    stop. Stop/Pause expresses "I want control now"; the panel surfaces a
 *    "Start next" button instead of auto-launching more work.
 *
 * Used by both the start route (for a fresh manual run) and the drain chain
 * itself (for a queue-triggered run), so every run — however it started —
 * feeds the same advance/hold logic exactly once.
 */
export async function advanceQueueAfter(
  run: Promise<SyncRunResult>
): Promise<SyncRunResult> {
  let result: SyncRunResult;
  try {
    result = await run;
  } catch (error) {
    // Unexpected: the run rejected outright instead of settling into a
    // completed/failed SyncLog (e.g. the DB-level single-flight guard in
    // runSync tripped). Hold rather than tight-looping retries against
    // whatever's wrong.
    setQueueHeld(true);
    throw error;
  }
  if (result.status === "completed" || result.status === "failed") {
    drainNextQueuedSync();
  } else {
    setQueueHeld(true);
  }
  return result;
}

export type StartNextQueuedResult =
  | { ok: true; entry: QueueEntry }
  | { ok: false; reason: "running" | "empty" };

/**
 * The "Start next" button's server-side action: clears the held flag and
 * starts the next queued entry, chaining the same advance/hold logic onto
 * it. 409s (via the caller) when a sync is already running or the queue is
 * empty.
 */
export function startNextQueuedSync(): StartNextQueuedResult {
  if (getSyncProgress().running) return { ok: false, reason: "running" };
  const next = shiftQueueEntry();
  if (!next) return { ok: false, reason: "empty" };
  setQueueHeld(false);
  void advanceQueueAfter(startQueuedEntry(next)).catch((error) =>
    console.error(`Queued sync (${next.kind}) failed to start:`, error)
  );
  return { ok: true, entry: next };
}
