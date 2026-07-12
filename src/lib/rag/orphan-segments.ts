import { prisma } from "@/lib/db";
import { getProductDefinitions } from "./product-defs";

/**
 * Orphan-segment insight for the /rag page: Crisp segments
 * (Conversation.tags entries) that match NO product/plugin definition, with
 * how many conversations carry each. These are the segments a chunk's
 * detection would fall through — the owner can add a plugin or a detection
 * keyword so future chunks get scoped to the right brand/plugin.
 *
 * Read-only: aggregates tag counts in SQL, then filters out any tag that
 * matches a plugin name or detection keyword using the SAME patterns the
 * chunker uses (case-insensitive, space-tolerant), so "matched" here means
 * exactly "detection would map this segment to a product".
 */

export interface OrphanSegment {
  tag: string;
  /** Conversations carrying this segment. */
  count: number;
}

export async function getOrphanSegments(
  limit = 20
): Promise<OrphanSegment[]> {
  const defs = await getProductDefinitions();

  // Aggregate conversation counts per distinct tag in SQL (tags unnested).
  const rows = await prisma.$queryRaw<Array<{ tag: string; count: number }>>`
    SELECT tag, COUNT(*)::int AS count
    FROM "Conversation", unnest("tags") AS tag
    WHERE btrim(tag) <> ''
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `;

  const matchesAnyProduct = (tag: string): boolean =>
    defs.some((def) => def.patterns.some((pattern) => pattern.test(tag)));

  return rows
    .filter((row) => !matchesAnyProduct(row.tag))
    .slice(0, limit)
    .map((row) => ({ tag: row.tag, count: Number(row.count) }));
}
