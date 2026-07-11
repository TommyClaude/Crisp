import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { embeddingsConfigured } from "@/env";
import { cosineSimilarity, embedTexts } from "./embeddings";

/**
 * Layered RAG search over embedding chunks:
 *
 *   1. "vector"  — pgvector column present + OpenAI key → ANN search in SQL.
 *   2. "hybrid"  — OpenAI key but no pgvector → keyword prefilter, then
 *                  cosine re-ranking in JS over JSON-stored embeddings.
 *   3. "keyword" — no OpenAI key → Postgres full-text search with ILIKE
 *                  fallback.
 *
 * Chunks come from three sources — archived Crisp conversations
 * ("crisp_chat"), crawled plugin documentation ("plugin_docs") and ingested
 * wp.org support-forum Q&A threads ("wporg_forum") — and every result links
 * back to its source conversation or docs/forum page.
 */

export type RagSearchMode = "vector" | "hybrid" | "keyword";
export type ChunkSource = "crisp_chat" | "plugin_docs" | "wporg_forum";

export interface RagSearchFilters {
  source?: ChunkSource;
  pluginId?: string;
  brandId?: string;
}

export interface RagSearchResult {
  chunkId: string;
  chunkText: string;
  source: ChunkSource;
  product: string | null;
  topic: string | null;
  language: string | null;
  pluginName: string | null;
  similarity: number | null;
  conversation: {
    sessionId: string;
    state: string | null;
    visitorNickname: string | null;
    tags: string[];
    createdAtCrisp: string | null;
  } | null;
  docsPage: {
    url: string;
    title: string | null;
  } | null;
}

export interface RagSearchResponse {
  mode: RagSearchMode;
  query: string;
  results: RagSearchResult[];
}

let pgvectorAvailable: boolean | null = null;

/** Detect (once per process) whether the optional pgvector column exists. */
export async function hasPgvector(): Promise<boolean> {
  if (pgvectorAvailable !== null) return pgvectorAvailable;
  try {
    const rows = await prisma.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok
      FROM pg_extension e
      JOIN information_schema.columns c
        ON c.table_name = 'EmbeddingChunk' AND c.column_name = 'embedding'
      WHERE e.extname = 'vector'
      LIMIT 1
    `;
    pgvectorAvailable = rows.length > 0;
    return pgvectorAvailable;
  } catch (error) {
    // A transient DB error must not pin a pgvector-enabled database to the
    // slow fallback path for the process lifetime — only cache success.
    console.error("pgvector detection failed (will retry next call):", error);
    return false;
  }
}

/** Format a float array as a pgvector literal: [0.1,0.2,...]. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Persist embeddings for chunks. Uses the pgvector column when available,
 * otherwise stores the vector as JSON for in-app cosine ranking.
 */
export async function storeChunkEmbeddings(
  chunkIds: string[],
  vectors: number[][]
): Promise<void> {
  const usePgvector = await hasPgvector();
  const writes = chunkIds.map((id, i) =>
    usePgvector
      ? prisma.$executeRaw`
          UPDATE "EmbeddingChunk"
          SET embedding = ${toVectorLiteral(vectors[i])}::vector,
              "embeddingJson" = NULL
          WHERE id = ${id}
        `
      : prisma.embeddingChunk.update({
          where: { id },
          data: { embeddingJson: vectors[i] },
        })
  );
  // Batch the row updates to avoid one DB round-trip per chunk.
  const BATCH = 25;
  for (let i = 0; i < writes.length; i += BATCH) {
    await prisma.$transaction(writes.slice(i, i + BATCH));
  }
}

const conversationSelect = {
  sessionId: true,
  state: true,
  visitorNickname: true,
  tags: true,
  createdAtCrisp: true,
} satisfies Prisma.ConversationSelect;

const chunkHydrateInclude = {
  conversation: { select: conversationSelect },
  docsPage: { select: { url: true, title: true } },
  plugin: { select: { name: true } },
} satisfies Prisma.EmbeddingChunkInclude;

type HydratedChunk = Prisma.EmbeddingChunkGetPayload<{
  include: typeof chunkHydrateInclude;
}>;

/** SQL fragment applying source/plugin/brand filters (starts with AND). */
function chunkFilterSql(filters?: RagSearchFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filters?.source) {
    conditions.push(Prisma.sql`"source" = ${filters.source}`);
  }
  if (filters?.pluginId) {
    conditions.push(Prisma.sql`"pluginId" = ${filters.pluginId}`);
  }
  if (filters?.brandId) {
    conditions.push(Prisma.sql`(
      "conversationId" IN (SELECT id FROM "Conversation" WHERE "brandId" = ${filters.brandId})
      OR "pluginId" IN (SELECT id FROM "Plugin" WHERE "brandId" = ${filters.brandId})
    )`);
  }
  if (conditions.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.join(conditions, " AND ")}`;
}

/** Prisma where clause applying the same source/plugin/brand filters. */
function chunkFilterWhere(
  filters?: RagSearchFilters
): Prisma.EmbeddingChunkWhereInput {
  const where: Prisma.EmbeddingChunkWhereInput = {};
  if (filters?.source) where.source = filters.source;
  if (filters?.pluginId) where.pluginId = filters.pluginId;
  if (filters?.brandId) {
    where.OR = [
      { conversation: { brandId: filters.brandId } },
      { plugin: { brandId: filters.brandId } },
    ];
  }
  return where;
}

function toResult(
  chunk: HydratedChunk,
  similarity: number | null
): RagSearchResult {
  return {
    chunkId: chunk.id,
    chunkText: chunk.chunkText,
    source: (chunk.source as ChunkSource) ?? "crisp_chat",
    product: chunk.product,
    topic: chunk.topic,
    language: chunk.language,
    pluginName: chunk.plugin?.name ?? null,
    similarity,
    conversation: chunk.conversation
      ? {
          sessionId: chunk.conversation.sessionId,
          state: chunk.conversation.state,
          visitorNickname: chunk.conversation.visitorNickname,
          tags: chunk.conversation.tags,
          createdAtCrisp:
            chunk.conversation.createdAtCrisp?.toISOString() ?? null,
        }
      : null,
    docsPage: chunk.docsPage
      ? { url: chunk.docsPage.url, title: chunk.docsPage.title }
      : null,
  };
}

/** Fetch full rows for ranked chunk ids, preserving the given order. */
async function hydrateResults(
  ranked: Array<{ id: string; similarity: number | null }>
): Promise<RagSearchResult[]> {
  if (ranked.length === 0) return [];
  const chunks = await prisma.embeddingChunk.findMany({
    where: { id: { in: ranked.map((r) => r.id) } },
    include: chunkHydrateInclude,
  });
  const byId = new Map(chunks.map((c) => [c.id, c]));
  return ranked.flatMap(({ id, similarity }) => {
    const chunk = byId.get(id);
    return chunk ? [toResult(chunk, similarity)] : [];
  });
}

async function vectorSearch(
  queryVector: number[],
  limit: number,
  filters?: RagSearchFilters
): Promise<RagSearchResult[]> {
  const literal = toVectorLiteral(queryVector);
  const rows = await prisma.$queryRaw<
    Array<{ id: string; similarity: number }>
  >`
    SELECT id, 1 - (embedding <=> ${literal}::vector) AS similarity
    FROM "EmbeddingChunk"
    WHERE embedding IS NOT NULL ${chunkFilterSql(filters)}
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `;
  return hydrateResults(rows);
}

async function runFullTextQuery(
  tsQuery: string,
  limit: number,
  filters?: RagSearchFilters
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "EmbeddingChunk"
    WHERE to_tsvector('simple', "chunkText")
          @@ websearch_to_tsquery('simple', ${tsQuery})
      ${chunkFilterSql(filters)}
    ORDER BY ts_rank(
      to_tsvector('simple', "chunkText"),
      websearch_to_tsquery('simple', ${tsQuery})
    ) DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/**
 * Full-text candidates via websearch_to_tsquery, ranked by ts_rank.
 * Tries strict AND semantics first; when nothing matches, retries with OR
 * semantics so queries with one off-vocabulary word still return results.
 */
async function keywordCandidateIds(
  query: string,
  limit: number,
  filters?: RagSearchFilters
): Promise<string[]> {
  try {
    const strict = await runFullTextQuery(query, limit, filters);
    if (strict.length > 0) return strict;

    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/["']/g, ""))
      .filter((t) => t.length > 1);
    if (terms.length < 2) return [];
    return await runFullTextQuery(terms.join(" OR "), limit, filters);
  } catch (error) {
    // Don't silently degrade to "no results" when the SQL itself is broken
    // (e.g. FTS migration not applied) — surface it in the logs.
    console.error("Full-text chunk search failed:", error);
    return [];
  }
}

async function keywordSearch(
  query: string,
  limit: number,
  filters?: RagSearchFilters
): Promise<RagSearchResult[]> {
  let ids = await keywordCandidateIds(query, limit, filters);

  if (ids.length === 0) {
    // ILIKE fallback for partial words / stopword-only queries.
    const contains = await prisma.embeddingChunk.findMany({
      where: {
        ...chunkFilterWhere(filters),
        chunkText: { contains: query, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true },
    });
    ids = contains.map((c) => c.id);
  }
  return hydrateResults(ids.map((id) => ({ id, similarity: null })));
}

/**
 * Cosine re-ranking over JSON-stored embeddings (no pgvector).
 * Candidates are fetched with a slim select (id + embedding only); the full
 * chunk rows are hydrated only for the top-k winners, so a query never drags
 * thousands of chunk texts across the wire. For large archives, enable
 * pgvector (prisma/sql/enable-pgvector.sql) instead.
 */
async function hybridSearch(
  query: string,
  queryVector: number[],
  limit: number,
  filters?: RagSearchFilters
): Promise<RagSearchResult[]> {
  // Keyword prefilter keeps the candidate set small; when it finds too few,
  // widen to the most recent chunks that have embeddings.
  const prefilterIds = await keywordCandidateIds(query, 300, filters);
  const candidates = await prisma.embeddingChunk.findMany({
    where: {
      ...chunkFilterWhere(filters),
      ...(prefilterIds.length >= limit ? { id: { in: prefilterIds } } : {}),
      embeddingJson: { not: Prisma.DbNull },
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
    select: { id: true, embeddingJson: true },
  });

  const winners = candidates
    .map((chunk) => ({
      id: chunk.id,
      similarity: cosineSimilarity(
        queryVector,
        (chunk.embeddingJson as number[]) ?? []
      ),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
  return hydrateResults(winners);
}

export async function ragSearch(
  query: string,
  options?: { limit?: number } & RagSearchFilters
): Promise<RagSearchResponse> {
  const limit = options?.limit ?? 8;
  const filters: RagSearchFilters = {
    source: options?.source,
    pluginId: options?.pluginId,
    brandId: options?.brandId,
  };
  const trimmed = query.trim();
  if (!trimmed) return { mode: "keyword", query, results: [] };

  if (embeddingsConfigured()) {
    const [queryVector] = await embedTexts([trimmed]);
    if (await hasPgvector()) {
      const results = await vectorSearch(queryVector, limit, filters);
      // A pgvector DB with no embedded rows yet still deserves results.
      if (results.length > 0) return { mode: "vector", query: trimmed, results };
    }
    const results = await hybridSearch(trimmed, queryVector, limit, filters);
    if (results.length > 0) return { mode: "hybrid", query: trimmed, results };
  }

  return {
    mode: "keyword",
    query: trimmed,
    results: await keywordSearch(trimmed, limit, filters),
  };
}
