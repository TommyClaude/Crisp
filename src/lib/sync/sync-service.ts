import { prisma } from "@/lib/db";
import { getEnv } from "@/env";
import { CrispApiError, CrispClient } from "@/lib/crisp/client";
import type { CrispConversation, CrispMessage } from "@/lib/crisp/types";
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
  type SyncKind,
} from "./sync-state";
import {
  classifyRangePage,
  COVERAGE_BASIS_LABEL,
  shouldStopRangeWalk,
} from "./coverage";

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
): Promise<{ conversationId: string; messageCount: number }> {
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

  return { conversationId: dbConversation.id, messageCount: messages.length };
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
  startPage?: number;
  /** Only sync conversations updated at/after this time (incremental). */
  updatedSince?: Date | null;
  /**
   * Range mode (kind "range"): page-walk with Crisp's date filter applied and
   * a per-page early-stop guard. Both bounds are required together.
   */
  dateStart?: Date;
  dateEnd?: Date;
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

  // DB-level single-flight guard: the in-memory flag above only protects one
  // process; a CLI run and the web app (or two app instances) share the DB.
  // Runs older than the staleness window are assumed crashed and ignored.
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
      pageFrom: options.startPage ?? 1,
    },
  });
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
    const targets = await getSyncTargets();
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

      // startPage resumes the FIRST brand only — later brands always start
      // from page 1 (their progress was not what got interrupted).
      let page = t === 0 ? (options.startPage ?? 1) : 1;
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
            state.messagesSynced += result.messageCount;

            if (conversation.state === "resolved") {
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

        // Persist page-level progress so the run is resumable.
        await prisma.syncLog.update({
          where: { id: syncLog.id },
          data: {
            pageTo: page,
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
          if (conversation.state === "resolved") {
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

/** The subset of SyncLog columns {@link computeResumePage} needs. */
export interface ResumeCandidate {
  kind: string;
  pageFrom: number | null;
  pageTo: number | null;
  conversationsSynced: number;
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

/** Full sync of all conversations, oldest data included. Resumable via startPage. */
export function runFullSync(options?: { startPage?: number }): Promise<SyncRunResult> {
  return runSync({ kind: "full", startPage: options?.startPage });
}

/**
 * Range sync: page-walk WITH Crisp's `filter_date_*` params applied, upserting
 * as usual, guarded so a fully-out-of-range page stops the walk early (see the
 * guard in {@link runSync}). Lets the owner refill a specific gap the coverage
 * heatmap surfaced without spending quota on a full backfill. The window is
 * inclusive and interpreted exactly as passed (callers build a UTC day window).
 */
export function runRangeSync(options: {
  dateStart: Date;
  dateEnd: Date;
  startPage?: number;
}): Promise<SyncRunResult> {
  return runSync({
    kind: "range",
    dateStart: options.dateStart,
    dateEnd: options.dateEnd,
    startPage: options.startPage,
  });
}

/**
 * Incremental sync: only conversations updated since the last successful run
 * (with a one-hour overlap). Falls back to a full sync when no successful
 * run exists yet.
 */
export async function runIncrementalSync(options?: {
  startPage?: number;
}): Promise<SyncRunResult> {
  const lastSuccess = await prisma.syncLog.findFirst({
    where: { status: "completed", kind: { in: ["full", "incremental"] } },
    orderBy: { startedAt: "desc" },
  });
  if (!lastSuccess) {
    return runSync({ kind: "full", startPage: options?.startPage });
  }
  const updatedSince = new Date(
    lastSuccess.startedAt.getTime() - INCREMENTAL_OVERLAP_MS
  );
  return runSync({
    kind: "incremental",
    updatedSince,
    startPage: options?.startPage,
  });
}
