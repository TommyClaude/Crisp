import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  runFullSync,
  runIncrementalSync,
  runRangeSync,
} from "@/lib/sync/sync-service";
import { getSyncProgress } from "@/lib/sync/sync-state";
import { isoDay, validateRange } from "@/lib/sync/range";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    mode: z.enum(["full", "incremental"]).default("full"),
    startPage: z.coerce.number().int().min(1).optional(),
    // Optional date range. Format is validated here; the both-or-neither and
    // start<=end cross-field checks live in validateRange (unit-tested).
    dateStart: isoDay.optional(),
    dateEnd: isoDay.optional(),
  })
  .default({ mode: "full" });

/**
 * POST /api/sync/crisp/start
 * Body: { mode?, startPage?, dateStart?, dateEnd? } (dates = YYYY-MM-DD;
 * startPage is only valid without a date range — range page numbers index
 * Crisp's filtered list, not the full archive, so the combination is rejected
 * rather than silently misinterpreted)
 *
 * Kicks off a background sync in this server process and returns immediately.
 * When both `dateStart` and `dateEnd` are given it runs a RANGE sync (Crisp's
 * date filter + early-stop guard); otherwise the usual full/incremental run.
 * Progress is exposed by /api/sync/crisp/status. For scheduled syncs, prefer
 * the CLI scripts (`npm run sync:crisp[:incremental]`).
 */
export async function POST(request: NextRequest) {
  let json: unknown = {};
  try {
    const text = await request.text();
    json = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { mode, startPage, dateStart, dateEnd } = parsed.data;

  // Cross-field range validation (both-or-neither, start <= end). A requested
  // range resolves to an inclusive UTC window; no range → window is null.
  const rangeCheck = validateRange(dateStart, dateEnd);
  if (!rangeCheck.ok) {
    return NextResponse.json({ error: rangeCheck.message }, { status: 400 });
  }
  if (rangeCheck.window && startPage != null) {
    return NextResponse.json(
      {
        error:
          "startPage cannot be combined with a date range — a range sync always walks Crisp's date-filtered pages from page 1.",
      },
      { status: 400 }
    );
  }

  const progress = getSyncProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "A sync is already running", progress },
      { status: 409 }
    );
  }

  const kind = rangeCheck.window ? "range" : mode;
  const run = rangeCheck.window
    ? runRangeSync({
        dateStart: rangeCheck.window.start,
        dateEnd: rangeCheck.window.end,
      })
    : mode === "incremental"
      ? runIncrementalSync({ startPage })
      : runFullSync({ startPage });
  // Fire-and-forget: the run updates SyncLog + in-memory progress itself.
  run.catch((error) => console.error("Background sync failed:", error));

  // Give the run a beat to register so the response includes a syncLogId.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return NextResponse.json(
    { started: true, mode: kind, progress: getSyncProgress() },
    { status: 202 }
  );
}
