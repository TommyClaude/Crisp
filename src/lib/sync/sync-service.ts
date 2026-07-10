import { prisma } from "@/lib/db";
import { getEnv } from "@/env";
import { getCrispClient } from "@/lib/crisp/client";
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

/** Upsert batch size for messages — keeps transactions small and memory flat. */
const MESSAGE_BATCH_SIZE = 50;
/** Safety cap on conversation list pages (30 conversations/page → 300k). */
const MAX_PAGES = 10_000;
/** Overlap window for incremental sync, to absorb clock skew. */
const INCREMENTAL_OVERLAP_MS = 60 * 60 * 1000;

export interface SyncRunResult {
  syncLogId: string;
  status: "completed" | "failed" | "cancelled";
  conversationsSynced: number;
  messagesSynced: number;
  failedSessions: string[];
  error?: string;
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
async function syncOperatorRoster(): Promise<void> {
  const client = getCrispClient();
  const operators = await client.listOperators();
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
  messages: CrispMessage[]
): Promise<{ conversationId: string; messageCount: number }> {
  const env = getEnv();
  const sessionId = conversation.session_id;
  if (!sessionId) throw new Error("Conversation payload missing session_id");

  const { assignedCrispUserId, ...columns } = conversationToColumns(
    conversation,
    env.CRISP_WEBSITE_ID
  );

  // The assignment FK references Operator.crispUserId — make sure it exists.
  if (assignedCrispUserId) await ensureOperator(assignedCrispUserId);

  const dbConversation = await prisma.conversation.upsert({
    where: { sessionId },
    create: {
      sessionId,
      ...columns,
      assignedOperatorId: assignedCrispUserId,
    },
    update: { ...columns, assignedOperatorId: assignedCrispUserId },
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
  const client = getCrispClient();
  const conversation = await client.getConversation(sessionId);
  const messages = await client.getAllMessages(sessionId);
  const result = await syncConversationPayload(conversation, messages);

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

  const syncLog = await prisma.syncLog.create({
    data: {
      kind: options.kind,
      status: "running",
      pageFrom: options.startPage ?? 1,
    },
  });
  const state = beginSyncProgress(options.kind, syncLog.id);

  const client = getCrispClient();
  const updatedSinceMs = options.updatedSince?.getTime() ?? null;
  let status: SyncRunResult["status"] = "completed";
  let errorMessage: string | undefined;

  try {
    try {
      await syncOperatorRoster();
    } catch (error) {
      console.warn("Operator roster sync failed (non-fatal):", error);
    }

    let page = options.startPage ?? 1;
    let reachedCheckpoint = false;

    while (page < MAX_PAGES && !reachedCheckpoint) {
      if (state.cancelRequested) {
        status = "cancelled";
        break;
      }

      state.currentPage = page;
      state.statusMessage = `fetching page ${page}`;
      const conversations = await client.listConversations(page);
      if (!conversations || conversations.length === 0) break;

      for (const conversation of conversations) {
        if (state.cancelRequested) {
          status = "cancelled";
          break;
        }
        const sessionId = conversation.session_id;
        if (!sessionId) continue;

        // Incremental mode: list is sorted by recent activity, so the first
        // conversation older than the checkpoint ends the whole run.
        if (
          updatedSinceMs !== null &&
          typeof conversation.updated_at === "number" &&
          conversation.updated_at < updatedSinceMs
        ) {
          reachedCheckpoint = true;
          break;
        }

        state.lastSessionId = sessionId;
        state.statusMessage = `syncing ${sessionId} (page ${page})`;
        try {
          const messages = await client.getAllMessages(sessionId);
          const result = await syncConversationPayload(conversation, messages);
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
      page += 1;
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
  };
}

/** Full sync of all conversations, oldest data included. Resumable via startPage. */
export function runFullSync(options?: { startPage?: number }): Promise<SyncRunResult> {
  return runSync({ kind: "full", startPage: options?.startPage });
}

/**
 * Incremental sync: only conversations updated since the last successful run
 * (with a one-hour overlap). Falls back to a full sync when no successful
 * run exists yet.
 */
export async function runIncrementalSync(): Promise<SyncRunResult> {
  const lastSuccess = await prisma.syncLog.findFirst({
    where: { status: "completed", kind: { in: ["full", "incremental"] } },
    orderBy: { startedAt: "desc" },
  });
  if (!lastSuccess) {
    return runSync({ kind: "full" });
  }
  const updatedSince = new Date(
    lastSuccess.startedAt.getTime() - INCREMENTAL_OVERLAP_MS
  );
  return runSync({ kind: "incremental", updatedSince });
}
