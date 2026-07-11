import { prisma } from "@/lib/db";
import { embeddingsConfigured } from "@/env";
import {
  buildChunksForConversation,
  isChunkableConversation,
} from "./chunker";
import { embedTexts } from "./embeddings";
import { getProductDefinitions } from "./product-defs";
import { storeChunkEmbeddings } from "./search";

export interface RebuildResult {
  conversationId: string;
  sessionId: string;
  chunksCreated: number;
  embedded: boolean;
  /**
   * True when the conversation failed the chunkability gate (no real
   * customer↔operator exchange, or known automated noise). Any chunks it
   * previously had were purged and none were created.
   */
  skipped?: boolean;
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
 */
export async function rebuildChunksForConversation(
  conversationId: string,
  options?: { withEmbeddings?: boolean }
): Promise<RebuildResult> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: { messages: true },
  });

  const eligible = isChunkableConversation(conversation.messages);
  const chunks = eligible
    ? buildChunksForConversation(
        conversation,
        conversation.messages,
        await getProductDefinitions()
      )
    : [];

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
        topic: chunk.topic,
        language: chunk.language,
        rawJson: chunk.rawJson,
      })),
      select: { id: true, chunkText: true },
    });
  });

  const wantEmbeddings = options?.withEmbeddings ?? true;
  let embedded = false;
  if (wantEmbeddings && embeddingsConfigured() && created.length > 0) {
    const vectors = await embedTexts(created.map((c) => c.chunkText));
    await storeChunkEmbeddings(
      created.map((c) => c.id),
      vectors
    );
    embedded = true;
  }

  return {
    conversationId,
    sessionId: conversation.sessionId,
    chunksCreated: created.length,
    embedded,
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
  errors: string[];
}> {
  const onlyResolved = options?.onlyResolved ?? true;
  const where = onlyResolved ? { state: "resolved" } : {};
  const conversations = await prisma.conversation.findMany({
    where,
    select: { id: true, sessionId: true },
    orderBy: { updatedAtCrisp: "desc" },
  });

  let chunkCount = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (let i = 0; i < conversations.length; i++) {
    try {
      const result = await rebuildChunksForConversation(conversations[i].id, {
        withEmbeddings: options?.withEmbeddings,
      });
      chunkCount += result.chunksCreated;
      if (result.skipped) skipped += 1;
    } catch (error) {
      errors.push(`${conversations[i].sessionId}: ${String(error)}`);
    }
    options?.onProgress?.(i + 1, conversations.length);
  }

  // Widen past the state filter: conversations that hold chunks but were not
  // iterated above must not keep stale chunks when they are no longer
  // eligible. Eligible ones (e.g. deliberately chunked via a per-conversation
  // rebuild while unresolved) are left untouched.
  let purged = 0;
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
          select: { from: true, type: true, content: true, timestampCrisp: true },
        },
      },
    });
    for (const holder of holders) {
      if (iterated.has(holder.id)) continue;
      if (isChunkableConversation(holder.messages)) continue;
      try {
        await prisma.embeddingChunk.deleteMany({
          where: { conversationId: holder.id },
        });
        purged += 1;
      } catch (error) {
        errors.push(`${holder.sessionId}: ${String(error)}`);
      }
    }
  }

  return {
    conversations: conversations.length,
    chunks: chunkCount,
    skipped,
    purged,
    errors,
  };
}
