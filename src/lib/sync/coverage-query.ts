import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  COVERAGE_BASIS,
  toMonthIndex,
  fromMonthIndex,
  parseMonthLabel,
  earliestDetectedMonth,
  type CoverageBasis,
  type CoverageResult,
  type YearMonth,
} from "./coverage";
import { getDetectedArchiveStart } from "./archive-start";

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

/** UTC (year, month) of a Date — buckets stay in lockstep with the SQL EXTRACT below. */
function yearMonthOf(date: Date): YearMonth {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export interface GetArchiveCoverageOptions {
  /**
   * Scope everything (monthly counts, DB minimums, the detected-start
   * lookup) to one Brand. Omit for the all-brands view (today's behaviour).
   * No UI wires this yet — the brand selector is a separate package — this
   * is just the query-layer plumbing for it, kept minimal on purpose.
   */
  brandId?: string;
}

/**
 * Conversations-per-month over the coverage basis, plus a count of rows whose
 * basis timestamp is NULL. Aggregated in SQL (a few dozen rows back), so this
 * stays cheap even at ~50k conversations. Buckets are UTC — Postgres EXTRACT on
 * the stored (UTC) timestamp — which keeps the heatmap in lockstep with the
 * range sync's UTC date-window interpretation.
 *
 * `earliestKnownMonth` (the grid's lower bound) is the min of two independent
 * signals: the DB's own MIN(createdAtCrisp)/MIN(updatedAtCrisp) — a
 * zero-request lower bound that "for free" stretches the grid back to cover
 * old conversations that were recently bumped — and the stored "Detect
 * archive start" probe result, if one has ever run (see
 * src/app/api/sync/crisp/detect-start/route.ts and the auto-detect-on-sync
 * hook in sync-service.ts). Either signal alone can be missing; only when
 * BOTH are absent is `earliestKnownMonth` null. With `options.brandId`, the
 * detected-start signal is that ONE brand's entry (not the all-brands
 * minimum) — matching what the DB-side filter is scoped to.
 */
export async function getArchiveCoverage(
  options?: GetArchiveCoverageOptions
): Promise<CoverageResult> {
  const basisSql = Prisma.raw(BASIS_SQL_IDENTIFIER[COVERAGE_BASIS]);
  const brandId = options?.brandId;
  // Prisma.empty splices to nothing, so the query reads identically to the
  // unfiltered form when no brandId is given.
  const brandFilterSql = brandId
    ? Prisma.sql`AND "brandId" = ${brandId}`
    : Prisma.empty;
  const brandWhere = brandId ? { brandId } : {};

  const [rows, total, unknownCount, minDates, detectedArchiveStart] =
    await Promise.all([
      prisma.$queryRaw<Array<{ year: number; month: number; count: number }>>(
        Prisma.sql`
          SELECT EXTRACT(YEAR FROM ${basisSql})::int  AS year,
                 EXTRACT(MONTH FROM ${basisSql})::int AS month,
                 COUNT(*)::int                        AS count
          FROM "Conversation"
          WHERE ${basisSql} IS NOT NULL
          ${brandFilterSql}
          GROUP BY year, month
          ORDER BY year, month
        `
      ),
      prisma.conversation.count({ where: brandWhere }),
      prisma.conversation.count({
        where: {
          ...brandWhere,
          ...(COVERAGE_BASIS === "updatedAtCrisp"
            ? { updatedAtCrisp: null }
            : { createdAtCrisp: null }),
        },
      }),
      prisma.conversation.aggregate({
        _min: { createdAtCrisp: true, updatedAtCrisp: true },
        where: brandWhere,
      }),
      getDetectedArchiveStart(),
    ]);

  // Ignore whichever of the two candidate minimums is NULL, then take the
  // earlier of the two that remain (a row can have one basis timestamp set
  // and the other NULL — this is deliberately NOT tied to COVERAGE_BASIS,
  // since either field bumping the grid back further is useful regardless of
  // which one the heatmap currently buckets by).
  const dbMinDate = [minDates._min.createdAtCrisp, minDates._min.updatedAtCrisp]
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const dbMinMonth = dbMinDate ? yearMonthOf(dbMinDate) : null;

  // Scoped to one brand: that brand's own detected month (a negative-cache
  // null entry counts as "no detected month"). All brands: the earliest
  // across every brand that HAS been detected (a brand with no entry yet
  // simply doesn't participate — its data still counts toward dbMinMonth
  // once synced).
  const brandDetectedLabel = brandId
    ? (detectedArchiveStart?.brands[brandId] ?? null)
    : null;
  const detectedMonth = brandId
    ? brandDetectedLabel
      ? parseMonthLabel(brandDetectedLabel)
      : null
    : detectedArchiveStart
      ? earliestDetectedMonth(detectedArchiveStart.brands)
      : null;

  const candidates = [dbMinMonth, detectedMonth].filter(
    (ym): ym is YearMonth => ym !== null
  );
  const earliestKnownMonth =
    candidates.length === 0
      ? null
      : fromMonthIndex(
          Math.min(...candidates.map((ym) => toMonthIndex(ym.year, ym.month)))
        );

  return {
    monthly: rows.map((r) => ({
      year: r.year,
      month: r.month,
      count: r.count,
    })),
    unknownCount,
    total,
    basis: COVERAGE_BASIS,
    earliestKnownMonth,
    detectedArchiveStart,
  };
}

