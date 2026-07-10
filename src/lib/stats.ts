import { prisma } from "@/lib/db";

/**
 * Aggregates for the global dashboard: tickets/threads first (the product),
 * then the knowledge base and its sources (Crisp archive, docs).
 */
export async function getGlobalStats() {
  const [
    threadStatusCounts,
    recentThreads,
    chunkSourceCounts,
    docsPageCount,
    pluginCount,
    brandCount,
    conversationCount,
    messageCount,
    lastSync,
  ] = await Promise.all([
    prisma.supportThread.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.supportThread.findMany({
      include: { plugin: { select: { name: true } } },
      orderBy: [
        { publishedAt: { sort: "desc", nulls: "last" } },
        { fetchedAt: "desc" },
      ],
      take: 6,
    }),
    prisma.embeddingChunk.groupBy({ by: ["source"], _count: { _all: true } }),
    prisma.docsPage.count(),
    prisma.plugin.count(),
    prisma.brand.count(),
    prisma.conversation.count(),
    prisma.message.count(),
    prisma.syncLog.findFirst({
      where: { status: "completed" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true, kind: true, status: true },
    }),
  ]);

  const threadsByStatus: Record<string, number> = {};
  for (const row of threadStatusCounts) {
    threadsByStatus[row.status] = row._count._all;
  }
  const chunksBySource: Record<string, number> = {};
  for (const row of chunkSourceCounts) {
    chunksBySource[row.source] = row._count._all;
  }

  return {
    threadsByStatus,
    totalThreads: Object.values(threadsByStatus).reduce((a, b) => a + b, 0),
    recentThreads,
    chunksBySource,
    totalChunks: Object.values(chunksBySource).reduce((a, b) => a + b, 0),
    docsPageCount,
    pluginCount,
    brandCount,
    conversationCount,
    messageCount,
    lastSync,
  };
}
