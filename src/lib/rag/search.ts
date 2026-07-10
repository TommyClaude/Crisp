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
 * Every result links back to its source conversation.
 */

export type RagSearchMode = "vector" | "hybrid" | "keyword";

export interface RagSearchResult {
  chunkId: string;
  chunkText: string;
  product: string | null;
  topic: string | null;
  language: string | null;
  similarity: number | null;
  conversation: {
    sessionId: string;
    state: string | null;
    visitorNickname: string | null;
    tags: string[];
    createdAtCrisp: string | null;
  };
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
  } catch {
    pgvectorAvailable = false;
  }
  return pgvectorAvailable;
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
  for (let i = 0; i < chunkIds.length; i++) {
    if (usePgvector) {
      await prisma.$executeRaw`
        UPDATE "EmbeddingChunk"
        SET embedding = ${toVectorLiteral(vectors[i])}::vector,
            "embeddingJson" = NULL
        WHERE id = ${chunkIds[i]}
      `;
    } else {
      await prisma.embeddingChunk.update({
        where: { id: chunkIds[i] },
        data: { embeddingJson: vectors[i] },
      });
    }
  }
}

const conversationSelect = {
  sessionId: true,
  state: true,
  visitorNickname: true,
  tags: true,
  createdAtCrisp: true,
} satisfies Prisma.ConversationSelect;

type ConversationSummary = {
  sessionId: string;
  state: string | null;
  visitorNickname: string | null;
  tags: string[];
  createdAtCrisp: Date | null;
};

function toResult(
  chunk: {
    id: string;
    chunkText: string;
    product: string | null;
    topic: string | null;
    language: string | null;
  },
  conversation: ConversationSummary,
  similarity: number | null
): RagSearchResult {
  return {
    chunkId: chunk.id,
    chunkText: chunk.chunkText,
    product: chunk.product,
    topic: chunk.topic,
    language: chunk.language,
    similarity,
    conversation: {
      sessionId: conversation.sessionId,
      state: conversation.state,
      visitorNickname: conversation.visitorNickname,
      tags: conversation.tags,
      createdAtCrisp: conversation.createdAtCrisp?.toISOString() ?? null,
    },
  };
}

async function vectorSearch(
  queryVector: number[],
  limit: number
): Promise<RagSearchResult[]> {
  const literal = toVectorLiteral(queryVector);
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      chunkText: string;
      product: string | null;
      topic: string | null;
      language: string | null;
      conversationId: string;
      similarity: number;
    }>
  >`
    SELECT id, "chunkText", product, topic, language, "conversationId",
           1 - (embedding <=> ${literal}::vector) AS similarity
    FROM "EmbeddingChunk"
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `;
  if (rows.length === 0) return [];

  const conversations = await prisma.conversation.findMany({
    where: { id: { in: rows.map((r) => r.conversationId) } },
    select: { id: true, ...conversationSelect },
  });
  const byId = new Map(conversations.map((c) => [c.id, c]));
  return rows.flatMap((row) => {
    const conversation = byId.get(row.conversationId);
    return conversation ? [toResult(row, conversation, row.similarity)] : [];
  });
}

async function runFullTextQuery(
  tsQuery: string,
  limit: number
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "EmbeddingChunk"
    WHERE to_tsvector('simple', "chunkText")
          @@ websearch_to_tsquery('simple', ${tsQuery})
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
  limit: number
): Promise<string[]> {
  try {
    const strict = await runFullTextQuery(query, limit);
    if (strict.length > 0) return strict;

    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/["']/g, ""))
      .filter((t) => t.length > 1);
    if (terms.length < 2) return [];
    return await runFullTextQuery(terms.join(" OR "), limit);
  } catch {
    return [];
  }
}

async function keywordSearch(
  query: string,
  limit: number
): Promise<RagSearchResult[]> {
  let ids = await keywordCandidateIds(query, limit);

  if (ids.length === 0) {
    // ILIKE fallback for partial words / stopword-only queries.
    const contains = await prisma.embeddingChunk.findMany({
      where: { chunkText: { contains: query, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true },
    });
    ids = contains.map((c) => c.id);
  }
  if (ids.length === 0) return [];

  const chunks = await prisma.embeddingChunk.findMany({
    where: { id: { in: ids } },
    include: { conversation: { select: conversationSelect } },
  });
  const byId = new Map(chunks.map((c) => [c.id, c]));
  // Preserve rank order from the FTS query.
  return ids.flatMap((id) => {
    const chunk = byId.get(id);
    return chunk ? [toResult(chunk, chunk.conversation, null)] : [];
  });
}

/** Cosine re-ranking over JSON-stored embeddings (no pgvector). */
async function hybridSearch(
  query: string,
  queryVector: number[],
  limit: number
): Promise<RagSearchResult[]> {
  // Keyword prefilter keeps the candidate set small; when it finds too few,
  // widen to the most recent chunks that have embeddings.
  const prefilterIds = await keywordCandidateIds(query, 300);
  const candidates = await prisma.embeddingChunk.findMany({
    where:
      prefilterIds.length >= limit
        ? { id: { in: prefilterIds }, embeddingJson: { not: Prisma.DbNull } }
        : { embeddingJson: { not: Prisma.DbNull } },
    orderBy: { createdAt: "desc" },
    take: 2000,
    include: { conversation: { select: conversationSelect } },
  });

  const scored = candidates
    .map((chunk) => ({
      chunk,
      similarity: cosineSimilarity(
        queryVector,
        (chunk.embeddingJson as number[]) ?? []
      ),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored.map(({ chunk, similarity }) =>
    toResult(chunk, chunk.conversation, similarity)
  );
}

export async function ragSearch(
  query: string,
  limit = 8
): Promise<RagSearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) return { mode: "keyword", query, results: [] };

  if (embeddingsConfigured()) {
    const [queryVector] = await embedTexts([trimmed]);
    if (await hasPgvector()) {
      const results = await vectorSearch(queryVector, limit);
      // A pgvector DB with no embedded rows yet still deserves results.
      if (results.length > 0) return { mode: "vector", query: trimmed, results };
    }
    const results = await hybridSearch(trimmed, queryVector, limit);
    if (results.length > 0) return { mode: "hybrid", query: trimmed, results };
  }

  return {
    mode: "keyword",
    query: trimmed,
    results: await keywordSearch(trimmed, limit),
  };
}
