import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CrispClient } from "@/lib/crisp/client";
import {
  earliestDetectedMonth,
  fromMonthIndex,
  toMonthIndex,
  formatMonthLabel,
  type DetectedArchiveStart,
  type YearMonth,
} from "./coverage";

// Server-only: reads/writes AppMeta and drives real Crisp probes. The
// client-safe DetectedArchiveStart type it reads/writes lives in ./coverage
// (no prisma import there) so the heatmap component can import it without
// pulling PrismaClient into the browser bundle — same split as
// ./coverage-query. Deliberately does NOT import ./sync-service (which
// imports this module for the auto-detect-on-full-sync hook) — the
// minimal `ArchiveStartTarget` shape below is structurally compatible with
// sync-service's SyncTarget, so no import (not even type-only) is needed and
// there's no risk of a circular dependency between the two.

/** AppMeta key backing the stored "Detect archive start" result. */
export const ARCHIVE_START_META_KEY = "crisp_archive_start";

/**
 * FLOOR month for the "Detect archive start" binary search: 2012-01, years
 * before Crisp itself existed (launched 2015) — cheap insurance that the
 * search range always brackets the true start, whatever it turns out to be.
 */
export const ARCHIVE_START_FLOOR: YearMonth = { year: 2012, month: 1 };

/** Inclusive lower bound (UTC) for every probe window — see {@link ARCHIVE_START_FLOOR}. */
export const ARCHIVE_START_FLOOR_DATE: Date = new Date(
  Date.UTC(ARCHIVE_START_FLOOR.year, ARCHIVE_START_FLOOR.month - 1, 1)
);

/** Last instant (UTC) of the given month — the inclusive upper bound of a probe window. */
export function endOfMonthUtc(year: number, month: number): Date {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, lastDay, 23, 59, 59, 999));
}

/** "YYYY-MM" from a month index, for storage/display. */
export function monthIndexToLabel(index: number): string {
  return formatMonthLabel(fromMonthIndex(index));
}

/** The subset of a sync target this module needs — see the file header for why this isn't imported from ./sync-service. */
export interface ArchiveStartTarget {
  brandId: string | null;
  websiteId: string;
}

/** Stable AppMeta map key for a target's brand — a legacy env-only target (no Brand row, brandId null) keys on "default". */
export function archiveStartBrandKey(target: Pick<ArchiveStartTarget, "brandId">): string {
  return target.brandId ?? "default";
}

/** Read the stored "Detect archive start" result, or null if it's never been run (or the row is malformed). */
export async function getDetectedArchiveStart(): Promise<DetectedArchiveStart | null> {
  const row = await prisma.appMeta.findUnique({
    where: { key: ARCHIVE_START_META_KEY },
  });
  const value = row?.value as Partial<DetectedArchiveStart> | null | undefined;
  if (
    value &&
    typeof value.brands === "object" &&
    value.brands !== null &&
    typeof value.detectedAt === "string" &&
    typeof value.requests === "number"
  ) {
    return {
      brands: value.brands as Record<string, string | null>,
      detectedAt: value.detectedAt,
      requests: value.requests,
    };
  }
  return null;
}

/** Persist a "Detect archive start" result exactly as given (overwrites any previous value — callers that need to preserve untouched brands should merge first, see {@link mergeAndStoreDetectedArchiveStart}). */
export async function storeDetectedArchiveStart(
  detected: DetectedArchiveStart
): Promise<void> {
  const value = detected as unknown as Prisma.InputJsonValue;
  await prisma.appMeta.upsert({
    where: { key: ARCHIVE_START_META_KEY },
    create: { key: ARCHIVE_START_META_KEY, value },
    update: { value },
  });
}

/**
 * Merge freshly probed per-brand months into any existing stored result, then
 * persist and return the merged value. Existing brand entries NOT present in
 * `fresh.brands` are kept as-is — the auto-detect-on-sync path only probes
 * brands missing an entry (see {@link autoDetectMissingBrands}), so a merge
 * (not an overwrite) is required to avoid losing brands detected earlier.
 * `detectedAt`/`requests` describe THIS store only, not a running total.
 */
export async function mergeAndStoreDetectedArchiveStart(
  fresh: DetectedArchiveStart
): Promise<DetectedArchiveStart> {
  const existing = await getDetectedArchiveStart();
  const merged: DetectedArchiveStart = {
    brands: { ...(existing?.brands ?? {}), ...fresh.brands },
    detectedAt: fresh.detectedAt,
    requests: fresh.requests,
  };
  await storeDetectedArchiveStart(merged);
  return merged;
}

/** One binary-search run's outcome, for tests to pin down exact convergence. */
export interface EarliestTrueSearch {
  /** Smallest index in [lo, hi] where the predicate holds, or null if it holds nowhere in range. */
  index: number | null;
  /** Total predicate calls made (Crisp requests, in the real caller). */
  requests: number;
  /** Indices probed, in call order. */
  probedIndices: number[];
}

/**
 * Binary-search the smallest index in `[lo, hi]` where `predicate` is true,
 * given `predicate` is monotone non-decreasing over the range (once true for
 * some index, true for every larger index too — exactly the shape of "does a
 * conversation exist in [FLOOR, end of month m]"). One probe up front checks
 * `hi`: if it's false, the predicate holds nowhere in range and the search
 * returns `index: null` without spending any further probes. Otherwise the
 * usual binary search converges in `ceil(log2(hi - lo + 1))` more probes, so
 * the whole run costs `1 + ceil(log2(hi - lo + 1))` predicate calls — about 9
 * for a ~15-year, 176-month range. Pure — unit-tested directly with a mocked
 * predicate (independent of Crisp/fetch).
 */
export async function findEarliestTrueIndex(
  lo: number,
  hi: number,
  predicate: (index: number) => Promise<boolean>
): Promise<EarliestTrueSearch> {
  const probedIndices: number[] = [];
  const probe = async (index: number): Promise<boolean> => {
    probedIndices.push(index);
    return predicate(index);
  };

  if (lo > hi) return { index: null, requests: 0, probedIndices };

  if (!(await probe(hi))) {
    return { index: null, requests: probedIndices.length, probedIndices };
  }

  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (await probe(mid)) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return { index: high, requests: probedIndices.length, probedIndices };
}

/**
 * Probe every given target (brand) for its earliest conversation month via
 * {@link findEarliestTrueIndex}, and return the per-brand result. Does NOT
 * touch AppMeta — callers decide whether/how to store it (see
 * storeDetectedArchiveStart / mergeAndStoreDetectedArchiveStart) — so the
 * same probing logic backs both the manual "Detect archive start" button
 * (probes every current brand, overwrite semantics) and the automatic
 * every-full-sync hook (probes only brands missing an entry, merge
 * semantics).
 *
 * Reuses the caller's CrispClient so every probe — across every target —
 * serializes through that client's existing rate-limited request queue; no
 * extra throttling here. Throws through on the first probe failure (network /
 * 429 / 5xx surviving the client's own retries) so a caller that wants an
 * all-or-nothing guarantee (the button) gets one; a caller that wants
 * "best-effort, never abort the bigger job" (the sync hook) wraps this in its
 * own try/catch.
 *
 * NOTE: this reuses the same undocumented Crisp date-filter basis as the
 * range sync (see COVERAGE_BASIS in coverage.ts) — `filter_date_*` most
 * likely matches last-activity, not created-date. That still finds the true
 * start month in practice: an early conversation that's never touched again
 * keeps its old `updated_at`, so it's still the earliest hit once the probe
 * window reaches its month.
 */
export async function detectArchiveStart(
  targets: ArchiveStartTarget[],
  client: Pick<CrispClient, "listConversations">
): Promise<DetectedArchiveStart> {
  const now = new Date();
  const floorIndex = toMonthIndex(ARCHIVE_START_FLOOR.year, ARCHIVE_START_FLOOR.month);
  const nowIndex = toMonthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1);

  const brands: Record<string, string | null> = {};
  let totalRequests = 0;

  for (const target of targets) {
    const { index, requests } = await findEarliestTrueIndex(
      floorIndex,
      nowIndex,
      async (monthIdx) => {
        const { year, month } = fromMonthIndex(monthIdx);
        const conversations = await client.listConversations(target.websiteId, 1, {
          dateStart: ARCHIVE_START_FLOOR_DATE,
          dateEnd: endOfMonthUtc(year, month),
        });
        return conversations.length > 0;
      }
    );
    totalRequests += requests;
    // A brand with no conversations at all records an explicit null — the
    // negative-cache entry that stops autoDetectMissingBrands from re-probing
    // it on every future full sync.
    brands[archiveStartBrandKey(target)] =
      index !== null ? monthIndexToLabel(index) : null;
  }

  return { brands, detectedAt: now.toISOString(), requests: totalRequests };
}

/**
 * Auto-detect archive start for any of `targets` that don't already have a
 * stored entry (a negative-cache `null` counts as an entry — see
 * {@link DetectedArchiveStart}), merge the fresh results into AppMeta, and
 * return the merged value — or `null` when nothing was probed or nothing was
 * stored. Called at the start of every full sync (see runSync in
 * sync-service.ts); a probe failure here throws through (same as
 * {@link detectArchiveStart}) — it is the CALLER's job to catch it and treat
 * it as non-fatal, since detection must never abort the bigger sync it's
 * piggybacking on.
 *
 * Poisoning guard: results (including the negative entries) are only stored
 * when the merged map contains at least one REAL month. If every brand ever
 * probed came back empty, that's indistinguishable from Crisp silently
 * ignoring the date filter — caching "no conversations anywhere, forever"
 * on that evidence would permanently hide a working archive, so we store
 * nothing and let the next full sync (or the manual button, which surfaces
 * a clear 502) try again.
 */
export async function autoDetectMissingBrands(
  targets: ArchiveStartTarget[],
  client: Pick<CrispClient, "listConversations">
): Promise<DetectedArchiveStart | null> {
  const existing = await getDetectedArchiveStart();
  const existingBrands = existing?.brands ?? {};
  const missing = targets.filter(
    (target) => !(archiveStartBrandKey(target) in existingBrands)
  );
  if (missing.length === 0) return null;

  const fresh = await detectArchiveStart(missing, client);
  const mergedPreview = { ...existingBrands, ...fresh.brands };
  if (earliestDetectedMonth(mergedPreview) === null) return null;
  return mergeAndStoreDetectedArchiveStart(fresh);
}
