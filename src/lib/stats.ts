import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { embeddingsConfigured } from "@/env";
import { docsCrawlCap } from "@/lib/docs/crawler";
import { hasPgvector } from "@/lib/rag/search";

// Docs cap comes from its source of truth (env-tunable, DOCS_CRAWL_MAX_PAGES).
// The forum cap is still mirrored from src/lib/wporg/forum-crawler.ts
// DEFAULTS.maxThreads (not exported there).
const FORUM_THREAD_CRAWL_CAP = 200;

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

/**
 * Per-source chunk counts where a chunk "counts as embedded" when either the
 * JSON fallback column is populated, or — on a pgvector-enabled database —
 * the real `embedding` vector column is populated. The pgvector column isn't
 * modeled in prisma/schema.prisma (see enable-pgvector.sql), so it can only
 * be read with a raw query; that query only ever runs once hasPgvector() has
 * confirmed the column exists, and is wrapped defensively so a stale cache
 * or transient DB hiccup degrades to the JSON-only count instead of erroring
 * the whole dashboard.
 */
async function chunkEmbeddedCountsBySource(
  pgvectorActive: boolean
): Promise<Record<string, number>> {
  if (pgvectorActive) {
    try {
      const rows = await prisma.$queryRaw<
        Array<{ source: string; count: bigint }>
      >`
        SELECT source, COUNT(*) AS count
        FROM "EmbeddingChunk"
        WHERE "embeddingJson" IS NOT NULL OR embedding IS NOT NULL
        GROUP BY source
      `;
      return Object.fromEntries(rows.map((r) => [r.source, Number(r.count)]));
    } catch (error) {
      console.error(
        "pgvector embedded-count query failed, falling back to JSON-only count:",
        error
      );
    }
  }
  const rows = await prisma.embeddingChunk.groupBy({
    by: ["source"],
    where: { embeddingJson: { not: Prisma.DbNull } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.source, r._count._all]));
}

/** Truncate a stored error to a short, dashboard-friendly snippet. */
function errorSnippet(error: string | null): string | null {
  if (!error) return null;
  return error.length > 160 ? `${error.slice(0, 160)}…` : error;
}

export interface KnowledgeCoverageFailure {
  id: string;
  name: string;
  url: string;
  error: string | null;
}

export interface KnowledgeCoverageCapHit {
  id: string;
  name: string;
  url: string;
  pageCount: number;
}

export interface KnowledgeCoverage {
  /** Whether OPENAI_API_KEY is set — no key means keyword-only search. */
  embeddingsConfigured: boolean;
  /** Whether the optional pgvector column is present on this database. */
  pgvectorActive: boolean;
  chats: {
    resolvedCount: number;
    /** Distinct resolved-or-not conversations holding >=1 crisp_chat chunk. */
    conversationsWithChunks: number;
    chunks: number;
    chunksEmbedded: number;
  };
  docs: {
    sourceCount: number;
    totalPages: number;
    chunks: number;
    chunksEmbedded: number;
    failedSources: KnowledgeCoverageFailure[];
    capHit: KnowledgeCoverageCapHit[];
    /** Crawl stops at this many pages per source (see docs/crawler.ts). */
    pageCrawlCap: number;
  };
  forum: {
    sourceCount: number;
    totalTopics: number;
    chunks: number;
    chunksEmbedded: number;
    failedSources: KnowledgeCoverageFailure[];
    /** Newest-topics-per-run cap (see wporg/forum-crawler.ts). */
    topicsPerIngestCap: number;
  };
}

/**
 * "Has everything been chunked and embedded, and was anything missed?" —
 * per knowledge source, for the dashboard's Knowledge coverage panel.
 */
export async function getKnowledgeCoverage(): Promise<KnowledgeCoverage> {
  const pgvectorActive = await hasPgvector();

  const [
    resolvedCount,
    conversationsWithChunks,
    chatChunks,
    docsAgg,
    docsChunks,
    docsFailedSources,
    docsCapSources,
    forumAgg,
    forumChunks,
    forumFailedSources,
    embeddedBySource,
  ] = await Promise.all([
    prisma.conversation.count({ where: { state: "resolved" } }),
    prisma.conversation.count({
      where: { chunks: { some: { source: "crisp_chat" } } },
    }),
    prisma.embeddingChunk.count({ where: { source: "crisp_chat" } }),
    prisma.docsSource.aggregate({
      where: { type: { not: "wporg_forum" } },
      _count: { _all: true },
      _sum: { pageCount: true },
    }),
    prisma.embeddingChunk.count({ where: { source: "plugin_docs" } }),
    prisma.docsSource.findMany({
      where: { type: { not: "wporg_forum" }, status: "failed" },
      select: {
        id: true,
        url: true,
        error: true,
        plugin: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.docsSource.findMany({
      where: {
        type: { not: "wporg_forum" },
        pageCount: { gte: docsCrawlCap() },
        // A failed source already surfaces via failedSources; a stale
        // pageCount from an earlier successful crawl must not ALSO claim
        // "hit the cap" — the two warnings would contradict each other.
        status: { not: "failed" },
      },
      select: {
        id: true,
        url: true,
        pageCount: true,
        plugin: { select: { name: true } },
      },
      orderBy: { pageCount: "desc" },
    }),
    prisma.docsSource.aggregate({
      where: { type: "wporg_forum" },
      _count: { _all: true },
      _sum: { pageCount: true },
    }),
    prisma.embeddingChunk.count({ where: { source: "wporg_forum" } }),
    prisma.docsSource.findMany({
      where: { type: "wporg_forum", status: "failed" },
      select: {
        id: true,
        url: true,
        error: true,
        plugin: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    chunkEmbeddedCountsBySource(pgvectorActive),
  ]);

  return {
    embeddingsConfigured: embeddingsConfigured(),
    pgvectorActive,
    chats: {
      resolvedCount,
      conversationsWithChunks,
      chunks: chatChunks,
      chunksEmbedded: embeddedBySource.crisp_chat ?? 0,
    },
    docs: {
      sourceCount: docsAgg._count._all,
      totalPages: docsAgg._sum.pageCount ?? 0,
      chunks: docsChunks,
      chunksEmbedded: embeddedBySource.plugin_docs ?? 0,
      failedSources: docsFailedSources.map((s) => ({
        id: s.id,
        name: s.plugin.name,
        url: s.url,
        error: errorSnippet(s.error),
      })),
      capHit: docsCapSources.map((s) => ({
        id: s.id,
        name: s.plugin.name,
        url: s.url,
        pageCount: s.pageCount,
      })),
      pageCrawlCap: docsCrawlCap(),
    },
    forum: {
      sourceCount: forumAgg._count._all,
      totalTopics: forumAgg._sum.pageCount ?? 0,
      chunks: forumChunks,
      chunksEmbedded: embeddedBySource.wporg_forum ?? 0,
      failedSources: forumFailedSources.map((s) => ({
        id: s.id,
        name: s.plugin.name,
        url: s.url,
        error: errorSnippet(s.error),
      })),
      topicsPerIngestCap: FORUM_THREAD_CRAWL_CAP,
    },
  };
}
