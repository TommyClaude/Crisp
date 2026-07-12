import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  COVERAGE_BASIS,
  type CoverageBasis,
  type CoverageResult,
} from "./coverage";

// Server-only: this reads the database. The client-safe constants, types, and
// pure helpers it builds on live in ./coverage (no prisma import there, so the
// heatmap component can import them without pulling PrismaClient into the
// browser bundle).

/**
 * Quoted SQL identifiers for the two candidate basis columns. Interpolating a
 * column name into raw SQL is only safe for a fixed allowlist — this is it. The
 * value is a compile-time constant from a 2-member union and never user input,
 * but the allowlist guards against a future edit introducing injection.
 */
const BASIS_SQL_IDENTIFIER: Record<CoverageBasis, string> = {
  updatedAtCrisp: '"updatedAtCrisp"',
  createdAtCrisp: '"createdAtCrisp"',
};

/**
 * Conversations-per-month over the coverage basis, plus a count of rows whose
 * basis timestamp is NULL. Aggregated in SQL (a few dozen rows back), so this
 * stays cheap even at ~50k conversations. Buckets are UTC — Postgres EXTRACT on
 * the stored (UTC) timestamp — which keeps the heatmap in lockstep with the
 * range sync's UTC date-window interpretation.
 */
export async function getArchiveCoverage(): Promise<CoverageResult> {
  const basisSql = Prisma.raw(BASIS_SQL_IDENTIFIER[COVERAGE_BASIS]);

  const [rows, total, unknownCount] = await Promise.all([
    prisma.$queryRaw<Array<{ year: number; month: number; count: number }>>(
      Prisma.sql`
        SELECT EXTRACT(YEAR FROM ${basisSql})::int  AS year,
               EXTRACT(MONTH FROM ${basisSql})::int AS month,
               COUNT(*)::int                        AS count
        FROM "Conversation"
        WHERE ${basisSql} IS NOT NULL
        GROUP BY year, month
        ORDER BY year, month
      `
    ),
    prisma.conversation.count(),
    prisma.conversation.count({
      where:
        COVERAGE_BASIS === "updatedAtCrisp"
          ? { updatedAtCrisp: null }
          : { createdAtCrisp: null },
    }),
  ]);

  return {
    monthly: rows.map((r) => ({
      year: r.year,
      month: r.month,
      count: r.count,
    })),
    unknownCount,
    total,
    basis: COVERAGE_BASIS,
  };
}
