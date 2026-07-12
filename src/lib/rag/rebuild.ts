import { prisma } from "@/lib/db";
import { embeddingsConfigured } from "@/env";
import {
  buildChunksForConversation,
  isChunkableConversation,
} from "./chunker";
import { EMBEDDING_DIMENSIONS, embedTexts } from "./embeddings";
import { getProductDefinitions } from "./product-defs";
import { recordChunksRebuilt } from "./rebuild-advice";
import {
  beginRebuildProgress,
  endRebuildProgress,
} from "./rebuild-state";
import { hasPgvector, storeChunkEmbeddings } from "./search";

export interface RebuildResult {
  conversationId: string;
  sessionId: string;
  chunksCreated: number;
  embedded: boolean;
  /** New/changed chunks embedded via the OpenAI API this rebuild. */
  embeddedCount: number;
  /**
   * Chunks whose text was byte-identical to a pre-rebuild chunk, so their
   * existing embedding was reused instead of paying to re-embed it.
   */
  reusedCount: number;
  /**
   * True when the conversation failed the chunkability gate (no real
   * customer↔operator exchange, or known automated noise). Any chunks it
   * previously had were purged and none were created.
   */
  skipped?: boolean;
}

/**
 * Snapshot chunkText → embedding for a conversation's existing chunks, so a
 * rebuild can reuse the embedding of any chunk whose text is unchanged instead
 * of paying to re-embed it. Reads the pgvector column (as text) when present,
 * else the JSON fallback.
 *
 * Best-effort by design: on any error it returns an empty map, so the caller
 * simply re-embeds everything. A reused vector is only ever written for
 * byte-identical chunk text and only when it has the expected width, so reuse
 * can never leave a chunk with a mismatched embedding.
 */
async function snapshotEmbeddings(
  conversationId: string
): Promise<Map<string, number[]>> {
  const byText = new Map<string, number[]>();
  try {
    if (await hasPgvector()) {
      const rows = await prisma.$queryRaw<
        Array<{
          chunkText: string;
          embedding: string | null;
          embeddingJson: unknown;
        }>
      >`
        SELECT "chunkText", embedding::text AS embedding, "embeddingJson"
        FROM "EmbeddingChunk"
        WHERE "conversationId" = ${conversationId}
      `;
      for (const row of rows) {
        const vector =
          parseVectorLiteral(row.embedding) ?? asVector(row.embeddingJson);
        if (vector) byText.set(row.chunkText, vector);
      }
    } else {
      const rows = await prisma.embeddingChunk.findMany({
        where: { conversationId },
        select: { chunkText: true, embeddingJson: true },
      });
      for (const row of rows) {
        const vector = asVector(row.embeddingJson);
        if (vector) byText.set(row.chunkText, vector);
      }
    }
  } catch (error) {
    // Never let a snapshot failure corrupt or block the rebuild — fall back
    // to embedding every chunk normally.
    console.error(
      `Embedding snapshot failed for ${conversationId} (will re-embed):`,
      error
    );
    return new Map();
  }
  return byText;
}

/** A JSON embeddingJson value, validated to the expected width, else null. */
function asVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) return null;
  return value.every((n) => typeof n === "number" && Number.isFinite(n))
    ? (value as number[])
    : null;
}

/** Parse a pgvector `[0.1,0.2,...]::text` literal, validated to width, else null. */
function parseVectorLiteral(text: string | null): number[] | null {
  if (!text) return null;
  const inner = text.replace(/^\[|\]$/g, "");
  if (!inner) return null;
  const vector = inner.split(",").map(Number);
  if (vector.length !== EMBEDDING_DIMENSIONS) return null;
  return vector.some((n) => !Number.isFinite(n)) ? null : vector;
}

/**
 * Rebuild the RAG chunks for one conversation: delete existing chunks and
 * recreate them from the stored messages, then (optionally) embed them.
 * Delete+create runs in a transaction so a failure never leaves a
 * conversation half-chunked.
 *
 * Conversations that fail the data-quality gate (see
 * {@link isChunkableConversation}: no real customer↔operator exchange, or a
 * first message matching a known automated-noise pattern) produce zero
 * chunks — any existing chunks are deleted so a conversation that has become
 * ineligible is purged from the index.
 *
 * A conversation flagged junk (isJunk — set by the heuristic classifier at
 * sync, the backfill scan, or a human's manual mark) is kept out of the index
 * entirely: its existing chunks are deleted and none are rebuilt, returned as
 * `skipped` just like the chunkability gate. This gate runs BEFORE the
 * embedding snapshot/reuse path, so it never interferes with it.
 */
export async function rebuildChunksForConversation(
  conversationId: string,
  options?: { withEmbeddings?: boolean }
): Promise<RebuildResult> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: { messages: true },
  });

  if (conversation.isJunk) {
    await prisma.embeddingChunk.deleteMany({ where: { conversationId } });
    return {
      conversationId,
      sessionId: conversation.sessionId,
      chunksCreated: 0,
      embedded: false,
      embeddedCount: 0,
      reusedCount: 0,
      skipped: true,
    };
  }

  const eligible = isChunkableConversation(conversation.messages);
  const chunks = eligible
    ? buildChunksForConversation(
        conversation,
        conversation.messages,
        await getProductDefinitions()
      )
    : [];

  // Snapshot existing embeddings BEFORE the delete so unchanged chunk text can
  // reuse its embedding below instead of re-calling the OpenAI API.
  const priorEmbeddings = await snapshotEmbeddings(conversationId);

  const created = await prisma.$transaction(async (tx) => {
    await tx.embeddingChunk.deleteMany({ where: { conversationId } });
    if (chunks.length === 0) return [] as Array<{ id: string; chunkText: string }>;
    return tx.embeddingChunk.createManyAndReturn({
      data: chunks.map((chunk) => ({
        conversationId,
        chunkIndex: chunk.chunkIndex,
        messageIds: chunk.messageIds,
        chunkText: chunk.chunkText,
        product: chunk.product,
        pluginId: chunk.pluginId,
        topic: chunk.topic,
        language: chunk.language,
        rawJson: chunk.rawJson,
      })),
      select: { id: true, chunkText: true },
    });
  });

  const wantEmbeddings = options?.withEmbeddings ?? true;
  let embedded = false;
  let embeddedCount = 0;
  let reusedCount = 0;
  if (wantEmbeddings && embeddingsConfigured() && created.length > 0) {
    // Split into chunks we can reuse (byte-identical text with a snapshotted
    // embedding) and genuinely new/changed ones that must be embedded.
    const reuse: Array<{ id: string; vector: number[] }> = [];
    const toEmbed: Array<{ id: string; chunkText: string }> = [];
    for (const chunk of created) {
      const prior = priorEmbeddings.get(chunk.chunkText);
      if (prior) reuse.push({ id: chunk.id, vector: prior });
      else toEmbed.push(chunk);
    }

    // Store the reused vectors FIRST — they are already in memory and cost no
    // API call, so an embeddings-API outage below cannot throw them away. If
    // embedTexts then fails, only the genuinely new/changed chunks are left
    // unembedded (visible in the dashboard's embedded-vs-total gap) and the
    // next rebuild re-embeds just those; the reused ones stay intact.
    if (reuse.length > 0) {
      await storeChunkEmbeddings(
        reuse.map((r) => r.id),
        reuse.map((r) => r.vector)
      );
    }
    const fresh =
      toEmbed.length > 0
        ? await embedTexts(toEmbed.map((c) => c.chunkText))
        : [];
    if (toEmbed.length > 0) {
      await storeChunkEmbeddings(
        toEmbed.map((c) => c.id),
        fresh
      );
    }
    embedded = true;
    embeddedCount = toEmbed.length;
    reusedCount = reuse.length;
  }

  return {
    conversationId,
    sessionId: conversation.sessionId,
    chunksCreated: created.length,
    embedded,
    embeddedCount,
    reusedCount,
    ...(eligible ? {} : { skipped: true }),
  };
}

/**
 * Rebuild chunks for many conversations in batches. By default only resolved
 * conversations are chunked (they represent complete Q→A exchanges).
 *
 * Conversations outside the state filter that still hold chunks (e.g.
 * chunked while resolved, since reopened) are not skipped: any that are now
 * ineligible under the chunkability gate get their stale chunks purged.
 */
export async function rebuildAllChunks(options?: {
  onlyResolved?: boolean;
  withEmbeddings?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<{
  conversations: number;
  chunks: number;
  skipped: number;
  purged: number;
  embedded: number;
  reused: number;
  errors: string[];
  cancelled: boolean;
}> {
  // Claim the single-flight guard + reset live progress. This runs
  // synchronously before the first await, so a concurrent route-level start
  // observes running=true and returns 409 (see isRebuildRunning in the route).
  const progress = beginRebuildProgress();
  try {
    const onlyResolved = options?.onlyResolved ?? true;
    // Junk conversations are never chunked — exclude them from the work list
    // (they are purged separately below so any chunks they still hold go away).
    const where = onlyResolved
      ? { isJunk: false, state: "resolved" }
      : { isJunk: false };
    const conversations = await prisma.conversation.findMany({
      where,
      select: { id: true, sessionId: true },
      orderBy: { updatedAtCrisp: "desc" },
    });
    // `total`/`done` track the resolved-conversation work list only; the
    // stale-holder purge sweep below is bounded cleanup reported separately via
    // `purged`, and is run FIRST so the progress bar never regresses or
    // over-counts. The displayed numbers therefore never lie: done N of total M
    // is always "conversations chunked".
    progress.total = conversations.length;

    const errors: string[] = [];

    let purged = 0;

    // Junk conversations are excluded from the work list AND the holder sweep
    // below, so purge any chunks they still hold here (a conversation marked
    // junk after it was last chunked). Runs regardless of onlyResolved, and
    // honours a graceful Stop like the sweep below.
    const junkHolders = await prisma.conversation.findMany({
      where: { isJunk: true, chunks: { some: {} } },
      select: { id: true, sessionId: true },
    });
    for (const holder of junkHolders) {
      if (progress.cancelRequested) break;
      try {
        await prisma.embeddingChunk.deleteMany({
          where: { conversationId: holder.id },
        });
        purged += 1;
        progress.purged = purged;
      } catch (error) {
        errors.push(`${holder.sessionId}: ${String(error)}`);
      }
    }

    // Widen past the state filter next: conversations that hold chunks but are
    // not in the work list above must not keep stale chunks when they are no
    // longer eligible. Eligible ones (e.g. deliberately chunked via a
    // per-conversation rebuild while unresolved) are left untouched.
    if (onlyResolved) {
      const iterated = new Set(conversations.map((c) => c.id));
      const holders = await prisma.conversation.findMany({
        where: {
          chunks: { some: {} },
          OR: [{ state: null }, { state: { not: "resolved" } }],
        },
        select: {
          id: true,
          sessionId: true,
          messages: {
            select: {
              from: true,
              type: true,
              content: true,
              timestampCrisp: true,
            },
          },
        },
      });
      for (const holder of holders) {
        // The purge sweep honours Stop too — remaining stale chunks are
        // simply picked up by the next rebuild.
        if (progress.cancelRequested) break;
        if (iterated.has(holder.id)) continue;
        if (isChunkableConversation(holder.messages)) continue;
        try {
          await prisma.embeddingChunk.deleteMany({
            where: { conversationId: holder.id },
          });
          purged += 1;
          progress.purged = purged;
        } catch (error) {
          errors.push(`${holder.sessionId}: ${String(error)}`);
        }
      }
    }
    progress.purged = purged;

    let chunkCount = 0;
    let skipped = 0;
    let embedded = 0;
    let reused = 0;
    let cancelled = false;
    for (let i = 0; i < conversations.length; i++) {
      // Honour a graceful stop BEFORE any further chunk-building or embedding
      // for the next conversation. Work already committed stays.
      if (progress.cancelRequested) {
        cancelled = true;
        break;
      }
      try {
        const result = await rebuildChunksForConversation(conversations[i].id, {
          withEmbeddings: options?.withEmbeddings,
        });
        chunkCount += result.chunksCreated;
        progress.chunksCreated += result.chunksCreated;
        embedded += result.embeddedCount;
        reused += result.reusedCount;
        progress.embedded += result.embeddedCount;
        progress.reused += result.reusedCount;
        if (result.skipped) {
          skipped += 1;
          progress.skipped += 1;
        }
      } catch (error) {
        errors.push(`${conversations[i].sessionId}: ${String(error)}`);
      }
      progress.done = i + 1;
      options?.onProgress?.(i + 1, conversations.length);
    }

    endRebuildProgress(cancelled ? "cancelled" : "completed");
    // Only a run that re-indexed EVERY conversation under the current rules
    // refreshes the staleness marker: not cancelled, and no per-conversation
    // failures (a failed conversation may still carry old-rules chunks).
    // Bookkeeping failures must not fail the rebuild — the real work is
    // already committed — so this is best-effort.
    if (!cancelled && errors.length === 0) {
      try {
        await recordChunksRebuilt();
      } catch (error) {
        console.error("Failed to record chunk-rebuild bookkeeping:", error);
      }
    }
    return {
      conversations: conversations.length,
      chunks: chunkCount,
      skipped,
      purged,
      embedded,
      reused,
      errors,
      cancelled,
    };
  } catch (error) {
    endRebuildProgress("failed");
    throw error;
  }
}
