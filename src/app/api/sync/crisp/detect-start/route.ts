import { NextResponse } from "next/server";
import { CrispApiError } from "@/lib/crisp/client";
import { crispClientForTarget, getSyncTargets } from "@/lib/sync/sync-service";
import { getSyncProgress } from "@/lib/sync/sync-state";
import { earliestDetectedMonth, formatMonthLabel } from "@/lib/sync/coverage";
import {
  ARCHIVE_START_FLOOR,
  detectArchiveStart,
  mergeAndStoreDetectedArchiveStart,
} from "@/lib/sync/archive-start";

export const dynamic = "force-dynamic";

/**
 * POST /api/sync/crisp/detect-start
 *
 * The coverage heatmap's zero-request lower bound (DB MIN(createdAtCrisp) /
 * MIN(updatedAtCrisp), see coverage-query.ts) only reaches as far back as
 * whatever is already synced. This route spends a small, bounded number of
 * real Crisp requests to find the true archive start: the earliest month ANY
 * conversation exists, per brand, even one never synced locally.
 *
 * This is the MANUAL path (a dashboard button) — it always probes every
 * currently configured brand (see getSyncTargets, mirroring how runSync
 * resolves its targets) and overwrites their entries with fresh results,
 * regardless of what's already stored. The AUTOMATIC path — probing only
 * brands that don't have an entry yet — runs at the start of every
 * full sync instead (see autoDetectMissingBrands, called from runSync in
 * sync-service.ts); this route is the manual retry/refresh for it. Both
 * share the same probing logic ({@link detectArchiveStart} in
 * archive-start.ts — see its doc comment for the binary-search shape and the
 * date-filter-basis caveat) and the same merge-on-store semantics (see
 * {@link mergeAndStoreDetectedArchiveStart}), so neither path can clobber a
 * brand the other already found.
 *
 * One CrispClient shared across every brand's probes — same global token as
 * runSync's clientFor(), one rate-limited request queue, no extra throttling
 * needed here and no burst at brand boundaries. ~9 requests per brand; with
 * ≤3 brands that's ≤~27 requests total, small and one-off (the owner clicks
 * a button for this, it's not on any polling path).
 *
 * On success: stores `{ brands, detectedAt, requests }` in AppMeta (merged
 * with whatever was already there) and returns it, plus a convenience
 * `earliestMonth` — the min across `brands`, for the UI's toast/one-liner. On
 * any probe failure (network / 429 / 5xx surviving the client's own
 * retries), or if not a single conversation exists on any configured
 * website, nothing is stored and the response is `502` with a clear message
 * — a partial/wrong result is worse than no result for a value the grid
 * trusts.
 */
export async function POST() {
  // Same single-flight rule as /api/sync/crisp/start: a running sync may be
  // mid-probe itself (the auto-detect hook), and two uncoordinated clients
  // racing the AppMeta read-modify-write could drop a brand entry. Probing is
  // cheap — waiting for the sync to finish costs nothing.
  const progress = getSyncProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "A sync is already running — detect archive start when it finishes.", progress },
      { status: 409 }
    );
  }

  let targets;
  try {
    targets = await getSyncTargets();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }

  // One shared client across every brand's probes — same global token as
  // runSync's clientFor(), one request queue, no burst at brand boundaries.
  const client = crispClientForTarget();

  let fresh;
  try {
    fresh = await detectArchiveStart(targets, client);
  } catch (error) {
    const message =
      error instanceof CrispApiError
        ? `Crisp probe failed: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Every probed brand may now carry an explicit negative entry (null), so
  // "found nothing anywhere" means no REAL month across the fresh result.
  if (earliestDetectedMonth(fresh.brands) === null) {
    return NextResponse.json(
      {
        error:
          "No conversations found on any configured Crisp website between " +
          `${ARCHIVE_START_FLOOR.year}-${String(ARCHIVE_START_FLOOR.month).padStart(2, "0")} and now — nothing to detect.`,
      },
      { status: 502 }
    );
  }

  const stored = await mergeAndStoreDetectedArchiveStart(fresh);
  const earliest = earliestDetectedMonth(stored.brands);

  return NextResponse.json({
    ...stored,
    earliestMonth: earliest ? formatMonthLabel(earliest) : null,
  });
}
