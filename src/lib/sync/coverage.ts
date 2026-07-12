import type { CrispConversation } from "@/lib/crisp/types";

// This module is intentionally free of server-only imports (no prisma / no
// PrismaClient) so the client heatmap component can import its pure helpers and
// types. The DB aggregation that reads these constants lives in the server-only
// ./coverage-query module.

/**
 * Archive-coverage basis — the ONE conversation timestamp that every
 * coverage feature buckets by.
 *
 * Three features read this single constant and MUST agree:
 *   1. the coverage heatmap card (which months look empty),
 *   2. the date-range sync's Crisp filter (which months we refill), and
 *   3. the in-range/out-of-range verification counts on a range run.
 *
 * They have to agree because the whole point is: the heatmap shows the owner a
 * gap, they click it, and the range sync fills *that* gap. If the heatmap
 * bucketed by created-date but the sync filtered by activity-date, a "gap"
 * could look filled (or unfillable) for reasons that have nothing to do with
 * missing data.
 *
 * We start with `updatedAtCrisp` (last activity) because Crisp's conversation
 * list is ordered by most-recent ACTIVITY, and its `filter_date_start` /
 * `filter_date_end` query params most likely match that same activity
 * timestamp — which the sync persists as `updatedAtCrisp`.
 *
 * HOW TO FLIP TO created-date: the first real range run reports its results by
 * BOTH bases, e.g. "in range by last-activity: 12/250, by created: 240/250".
 * If created clearly wins (Crisp's filter matches creation date), change this
 * one constant to `"createdAtCrisp"`. Every consumer derives from it —
 * {@link COVERAGE_BASIS_CRISP_FIELD}, the heatmap SQL, the range classifier —
 * so nothing else has to move.
 */
export type CoverageBasis = "updatedAtCrisp" | "createdAtCrisp";
export const COVERAGE_BASIS: CoverageBasis = "updatedAtCrisp";

/**
 * The raw Crisp payload field (ms epoch) that corresponds to
 * {@link COVERAGE_BASIS}. Used when a conversation is still a Crisp payload
 * (during a sync) rather than a persisted row.
 */
export const COVERAGE_BASIS_CRISP_FIELD: "updated_at" | "created_at" =
  COVERAGE_BASIS === "updatedAtCrisp" ? "updated_at" : "created_at";

/** Human label for the basis, for UI copy and verification lines. */
export const COVERAGE_BASIS_LABEL =
  COVERAGE_BASIS === "updatedAtCrisp" ? "last activity" : "created";

/** Read the basis timestamp (ms epoch) from a raw Crisp conversation payload. */
export function crispBasisEpoch(conversation: CrispConversation): number | null {
  const value = conversation[COVERAGE_BASIS_CRISP_FIELD];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** True/false when the epoch is inside the inclusive window, null when absent. */
export function epochInWindow(
  epoch: number | null,
  window: { start: Date; end: Date }
): boolean | null {
  if (epoch === null) return null;
  return epoch >= window.start.getTime() && epoch <= window.end.getTime();
}

/** One (year, month) bucket with its conversation count. month is 1-12. */
export interface CoverageMonthCount {
  year: number;
  month: number;
  count: number;
}

/** A (year, month) pair — month is 1-12. Used for span bounds. */
export interface YearMonth {
  year: number;
  month: number;
}

/**
 * Result of "Detect archive start" probing (see
 * src/app/api/sync/crisp/detect-start/route.ts and the auto-detect-on-first-
 * full-sync hook in sync-service.ts), as stored in AppMeta under
 * {@link ARCHIVE_START_META_KEY}. A client-safe type — the heatmap reads it
 * straight off the server-fetched {@link CoverageResult}.
 *
 * Shaped per brand (not collapsed to one earliest month) so a future
 * per-brand coverage view can read a specific brand's start directly instead
 * of the all-brands minimum. `detectedAt`/`requests` describe the MOST
 * RECENT store, not a lifetime total — a later run that only fills in
 * missing brands (see autoDetectMissingBrands) overwrites them with that
 * run's own smaller cost, while still merging (not replacing) `brands`.
 */
export interface DetectedArchiveStart {
  /**
   * Earliest known month ("YYYY-MM") per brand, keyed by Brand.id. A legacy
   * env-only setup (no Brand rows — see getSyncTargets) keys on "default".
   * `null` is a NEGATIVE cache entry: the brand was probed and has no
   * conversations at all, so the auto-detect-on-sync path must not spend
   * requests re-probing it every full sync. A later manual detect (which
   * always re-probes every brand) refreshes it.
   */
  brands: Record<string, string | null>;
  /** ISO timestamp of the most recent store (full or partial merge). */
  detectedAt: string;
  /** Crisp requests spent in that most recent store's probe(s). */
  requests: number;
}

/** Parse a "YYYY-MM" label into a YearMonth, or null if malformed. */
export function parseMonthLabel(label: string): YearMonth | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

/** "YYYY-MM" from a YearMonth, the inverse of {@link parseMonthLabel}. */
export function formatMonthLabel(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, "0")}`;
}

/**
 * Earliest month ("YYYY-MM") across every brand in a "Detect archive start"
 * result, or null when there's nothing to compare (an empty map, every label
 * malformed, or only negative-cache `null` entries — probed brands with no
 * conversations). Used both to combine per-brand results into the all-brands
 * grid span and by the UI's "Archive starts ... (detected)" line.
 */
export function earliestDetectedMonth(
  brands: Record<string, string | null>
): YearMonth | null {
  const indices = Object.values(brands)
    .map((label) => (label ? parseMonthLabel(label) : null))
    .filter((ym): ym is YearMonth => ym !== null)
    .map((ym) => toMonthIndex(ym.year, ym.month));
  if (indices.length === 0) return null;
  return fromMonthIndex(Math.min(...indices));
}

export interface CoverageResult {
  /** Non-empty months only, ascending. The UI fills the zero months. */
  monthly: CoverageMonthCount[];
  /** Conversations whose basis timestamp is NULL (can't be placed on the grid). */
  unknownCount: number;
  /** Total conversations in the archive (dated + unknown). */
  total: number;
  /** The basis this was bucketed by — echoed so the UI copy stays honest. */
  basis: CoverageBasis;
  /**
   * Earliest month the grid should render: the min of the DB's own
   * MIN(createdAtCrisp)/MIN(updatedAtCrisp) and the stored "Detect archive
   * start" result (if any). Null only when the archive has no dated
   * conversations and no start has been detected yet.
   */
  earliestKnownMonth: YearMonth | null;
  /** The stored "Detect archive start" probe result, if one has ever run. */
  detectedArchiveStart: DetectedArchiveStart | null;
}

/** A single month cell on the heatmap grid. */
export interface CoverageGridCell {
  year: number;
  month: number; // 1-12
  count: number;
}

export interface CoverageGridRow {
  year: number;
  cells: CoverageGridCell[]; // always length 12, Jan..Dec
}

export interface CoverageGrid {
  rows: CoverageGridRow[];
  /** Largest single-month count — the top of the intensity scale. */
  maxCount: number;
  /**
   * The span actually used to build `rows` — equal to the requested span,
   * except `start` may have been pulled forward by the {@link MAX_SPAN_YEARS}
   * clamp. The UI compares cells against THIS (not the requested span) to
   * decide which are dashed as "outside the archive", so the clamp logic
   * lives in exactly one place.
   */
  effectiveSpan: CoverageSpan;
}

/** Inclusive (start, end) month bounds the grid should render, both ends full months. */
export interface CoverageSpan {
  start: YearMonth;
  end: YearMonth;
  /**
   * Optional Conversation.brandId this span (and the `monthly` counts it's
   * paired with) is scoped to. buildCoverageGrid doesn't filter by it — the
   * caller must already have fetched brand-scoped `monthly` data (see
   * getArchiveCoverage's brandId option) — it's only echoed onto
   * `effectiveSpan` so a future per-brand view can tell which grid it's
   * looking at. Undefined/omitted means "all brands", same as today.
   */
  brandId?: string;
}

/**
 * Absolute, comparable/subtractable linear month index (no epoch offset —
 * safe for any real calendar year). Shared by the grid span clamp here and
 * the "Detect archive start" binary search, which both need to do month
 * arithmetic without re-deriving Date math each time.
 */
export function toMonthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/** Inverse of {@link toMonthIndex}. */
export function fromMonthIndex(index: number): YearMonth {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return { year, month };
}

/** Grid start is clamped to at most this many years before the span end, guarding against a pathological span (e.g. a bad timestamp) blowing the grid up to hundreds of rows. */
const MAX_SPAN_YEARS = 15;

/**
 * Expand the sparse monthly counts into a dense year-by-month grid spanning
 * `span.start`..`span.end` inclusive (both full years, Jan..Dec), clamped to
 * at most {@link MAX_SPAN_YEARS} years. Every month in range gets a cell —
 * including zero-count ones — so the UI can render them as gaps; months
 * outside the (possibly clamped) span are the caller's job to dim/dash (see
 * the heatmap's outside-span check). Pure — unit-tested directly.
 */
export function buildCoverageGrid(
  monthly: CoverageMonthCount[],
  span: CoverageSpan
): CoverageGrid {
  const byKey = new Map<string, number>();
  let maxCount = 0;
  for (const m of monthly) {
    byKey.set(`${m.year}-${m.month}`, m.count);
    if (m.count > maxCount) maxCount = m.count;
  }

  const endIndex = toMonthIndex(span.end.year, span.end.month);
  let startIndex = toMonthIndex(span.start.year, span.start.month);
  const minAllowedIndex = endIndex - MAX_SPAN_YEARS * 12;
  if (startIndex < minAllowedIndex) startIndex = minAllowedIndex;
  if (startIndex > endIndex) startIndex = endIndex;

  const effectiveStart = fromMonthIndex(startIndex);

  const rows: CoverageGridRow[] = [];
  for (let year = effectiveStart.year; year <= span.end.year; year++) {
    const cells: CoverageGridCell[] = [];
    for (let month = 1; month <= 12; month++) {
      cells.push({ year, month, count: byKey.get(`${year}-${month}`) ?? 0 });
    }
    rows.push({ year, cells });
  }
  return {
    rows,
    maxCount,
    effectiveSpan: { start: effectiveStart, end: span.end, brandId: span.brandId },
  };
}

/**
 * Intensity bucket for a cell: 0 for empty (a distinct "nothing here" style),
 * then 1-4 stepping up a single-hue ramp. A sqrt scale keeps a couple of huge
 * months from flattening every other month to the lowest step (conversation
 * volume is heavily skewed).
 */
export function intensityLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (maxCount <= 0) return 1;
  const ratio = Math.sqrt(count) / Math.sqrt(maxCount);
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** Per-page range-classification stats, accumulated across a range run. */
export interface RangePageStats {
  /** Conversations examined on this page. */
  seen: number;
  /** In-range by the coverage BASIS (drives the early-stop guard). */
  basisIn: number;
  /** Out-of-range by the coverage BASIS (demonstrably outside, not just null). */
  basisOut: number;
  /** In-range by updatedAtCrisp (last activity) — verification. */
  inByUpdated: number;
  /** In-range by createdAtCrisp — verification. */
  inByCreated: number;
}

/**
 * Classify one fetched page of conversations against the requested window, for
 * a range sync. Reports membership by BOTH candidate bases (so the owner can
 * see which one Crisp's filter actually honours) and, separately, by the active
 * basis (which drives {@link shouldStopRangeWalk}). Pure — unit-tested.
 */
export function classifyRangePage(
  conversations: CrispConversation[],
  window: { start: Date; end: Date }
): RangePageStats {
  const stats: RangePageStats = {
    seen: 0,
    basisIn: 0,
    basisOut: 0,
    inByUpdated: 0,
    inByCreated: 0,
  };
  for (const conversation of conversations) {
    stats.seen += 1;

    const updatedEpoch =
      typeof conversation.updated_at === "number" &&
      Number.isFinite(conversation.updated_at) &&
      conversation.updated_at > 0
        ? conversation.updated_at
        : null;
    const createdEpoch =
      typeof conversation.created_at === "number" &&
      Number.isFinite(conversation.created_at) &&
      conversation.created_at > 0
        ? conversation.created_at
        : null;

    if (epochInWindow(updatedEpoch, window) === true) stats.inByUpdated += 1;
    if (epochInWindow(createdEpoch, window) === true) stats.inByCreated += 1;

    const basisMember = epochInWindow(crispBasisEpoch(conversation), window);
    if (basisMember === true) stats.basisIn += 1;
    else if (basisMember === false) stats.basisOut += 1;
  }
  return stats;
}

/**
 * The early-stop guard. Crisp's docs are ambiguous about what
 * `filter_date_start`/`filter_date_end` match, and the filter might be ignored
 * entirely — in which case a range walk would degenerate into an unbounded full
 * walk. Stop when a page is demonstrably, entirely outside the range: NO
 * conversation is in-range by the basis AND at least one is provably out
 * (a page of only null-basis rows is processed, not stopped, since it proves
 * nothing about the filter).
 */
export function shouldStopRangeWalk(stats: RangePageStats): boolean {
  return stats.basisIn === 0 && stats.basisOut > 0;
}
