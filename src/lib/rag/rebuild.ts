import { prisma } from "@/lib/db";
import { embeddingsConfigured } from "@/env";
import { buildChunksForConversation } from "./chunker";
import { embedTexts } from "./embeddings";
import { storeChunkEmbeddings } from "./search";

export interface RebuildResult {
  conversationId: string;
  sessionId: string;
  chunksCreated: number;
  embedded: boolean;
}

/**
 * Rebuild the RAG chunks for one conversation: delete existing chunks and
 * recreate them from the stored messages, then (optionally) embed them.
 * Delete+create runs in a transaction so a failure never leaves a
 * conversation half-chunked.
 */
export async function rebuildChunksForConversation(
  conversationId: string,
  options?: { withEmbeddings?: boolean }
): Promise<RebuildResult> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: { messages: true },
  });

  const chunks = buildChunksForConversation(
    conversation,
    conversation.messages
  );

  const created = await prisma.$transaction(async (tx) => {
    await tx.embeddingChunk.deleteMany({ where: { conversationId } });
    if (chunks.length === 0) return [] as Array<{ id: string; chunkText: string }>;
    const rows = [];
    for (const chunk of chunks) {
      rows.push(
        await tx.embeddingChunk.create({
          data: {
            conversationId,
            chunkIndex: chunk.chunkIndex,
            messageIds: chunk.messageIds,
            chunkText: chunk.chunkText,
            product: chunk.product,
            topic: chunk.topic,
            language: chunk.language,
            rawJson: chunk.rawJson,
          },
          select: { id: true, chunkText: true },
        })
      );
    }
    return rows;
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
  };
}

/**
 * Rebuild chunks for many conversations in batches. By default only resolved
 * conversations are chunked (they represent complete Q→A exchanges).
 */
export async function rebuildAllChunks(options?: {
  onlyResolved?: boolean;
  withEmbeddings?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ conversations: number; chunks: number; errors: string[] }> {
  const onlyResolved = options?.onlyResolved ?? true;
  const where = onlyResolved ? { state: "resolved" } : {};
  const conversations = await prisma.conversation.findMany({
    where,
    select: { id: true, sessionId: true },
    orderBy: { updatedAtCrisp: "desc" },
  });

  let chunkCount = 0;
  const errors: string[] = [];
  for (let i = 0; i < conversations.length; i++) {
    try {
      const result = await rebuildChunksForConversation(conversations[i].id, {
        withEmbeddings: options?.withEmbeddings,
      });
      chunkCount += result.chunksCreated;
    } catch (error) {
      errors.push(`${conversations[i].sessionId}: ${String(error)}`);
    }
    options?.onProgress?.(i + 1, conversations.length);
  }

  return { conversations: conversations.length, chunks: chunkCount, errors };
}
