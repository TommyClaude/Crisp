import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  advanceQueueAfter,
  resolveStartPages,
  runFullSync,
  runIncrementalSync,
  runRangeSync,
} from "@/lib/sync/sync-service";
import { enqueueSync, getSyncProgress, MAX_QUEUE_SIZE } from "@/lib/sync/sync-state";
import { isoDay, validateRange } from "@/lib/sync/range";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    mode: z.enum(["full", "incremental"]).default("full"),
    startPage: z.coerce.number().int().min(1).optional(),
    // Scopes startPage to ONE brand (full/incremental only) — without it,
    // startPage keeps its legacy "resumes the first brand only" meaning. See
    // the startPageBrandId validation below.
    startPageBrandId: z.string().min(1).optional(),
    // Per-brand resume: server derives startPages from current SyncLog
    // history (getResumePages) — the client sends no numbers. Can combine
    // with startPage/startPageBrandId, which then overrides just that one
    // brand on top of the derived map.
    resume: z.boolean().optional(),
    // Optional date range. Format is validated here; the both-or-neither and
    // start<=end cross-field checks live in validateRange (unit-tested).
    dateStart: isoDay.optional(),
    dateEnd: isoDay.optional(),
    // Optional brand scope — only meaningful together with a date range (see
    // the range-required check below); full/incremental always cover every
    // brand.
    brandId: z.string().min(1).optional(),
  })
  .default({ mode: "full" });

/**
 * POST /api/sync/crisp/start
 * Body: { mode?, startPage?, startPageBrandId?, resume?, dateStart?, dateEnd?,
 * brandId? } (dates = YYYY-MM-DD; `startPage`/`startPageBrandId`/`resume` are
 * only valid without a date range — range page numbers index Crisp's
 * filtered list, not the full archive, so the combination is rejected rather
 * than silently misinterpreted; `brandId` is only valid WITH a date range —
 * full/incremental always cover every brand, so a bare `brandId` is rejected
 * the same way rather than silently dropped)
 *
 * Kicks off a background sync in this server process and returns immediately.
 * When both `dateStart` and `dateEnd` are given it runs a RANGE sync (Crisp's
 * date filter + early-stop guard), optionally narrowed to one brand via
 * `brandId`; otherwise the usual full/incremental run (which always covers
 * every brand). Progress is exposed by /api/sync/crisp/status. For scheduled
 * syncs, prefer the CLI scripts (`npm run sync:crisp[:incremental]`).
 *
 * **Per-brand resume** — `resume: true` tells the server to derive each
 * brand's own starting page from its furthest page across all history (see
 * `getResumePages`/`computeResumePages` in sync-service.ts); the client sends
 * no numbers. `startPage`, when given, is a manual override: by itself it
 * keeps its legacy meaning (resumes the FIRST configured brand only, every
 * other brand starts at page 1 — the original single-number behavior);
 * paired with `startPageBrandId` it instead overrides just THAT one brand.
 * `resume` and `startPage` can be combined — the explicit override then
 * merges ON TOP of the derived per-brand map (see `resolveStartPages`).
 * `startPageBrandId` requires `startPage` and must reference an existing
 * `Brand` row; both check 400 otherwise.
 *
 * All the validation above (range/brandId/startPage/startPageBrandId/resume
 * rules) runs BEFORE checking whether a sync is already running, so an
 * invalid request always 400s — it never gets queued. If a sync IS already
 * running, a validated request no longer 409s outright: it joins the
 * in-memory FIFO queue (see sync-state.ts) instead and this returns `202
 * {queued: true, position, entry}` — a queued `resume` entry re-derives its
 * per-brand map at DRAIN time, not at queue time, so it reflects everything
 * synced while it waited. Queuing itself can still 409 — an exact duplicate
 * of an already-queued entry ("already queued"; duplicating the RUNNING sync
 * is fine), or a full queue (max {@link MAX_QUEUE_SIZE}). Once queued, the
 * entry starts automatically when the running sync ends naturally (completed
 * or failed); a Stop/Pause instead HOLDS the queue for manual "Start next"
 * (see /api/sync/crisp/queue/start-next) — see advanceQueueAfter in
 * sync-service.ts for the full rationale.
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

  const { mode, startPage, startPageBrandId, resume, dateStart, dateEnd, brandId } =
    parsed.data;

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
  if (rangeCheck.window && resume) {
    return NextResponse.json(
      {
        error:
          "resume cannot be combined with a date range — a range sync always walks Crisp's date-filtered pages from page 1, and per-brand resume only applies to a full/incremental archive walk.",
      },
      { status: 400 }
    );
  }
  if (rangeCheck.window && startPageBrandId != null) {
    return NextResponse.json(
      {
        error:
          "startPageBrandId cannot be combined with a date range — it only scopes the startPage override for a full/incremental resume (a range sync is already brand-scoped via brandId).",
      },
      { status: 400 }
    );
  }
  if (!rangeCheck.window && brandId != null) {
    return NextResponse.json(
      {
        error:
          "brandId cannot be used without a date range — full/incremental syncs always cover every configured brand; only a range sync can be scoped to one.",
      },
      { status: 400 }
    );
  }
  if (startPageBrandId != null && startPage == null) {
    return NextResponse.json(
      {
        error:
          "startPageBrandId cannot be used without startPage — it only scopes which brand the override targets.",
      },
      { status: 400 }
    );
  }
  if (startPageBrandId != null) {
    const brand = await prisma.brand.findUnique({
      where: { id: startPageBrandId },
      select: { id: true },
    });
    if (!brand) {
      return NextResponse.json(
        {
          error: `Unknown brand: ${startPageBrandId} — no configured Brand has this id.`,
        },
        { status: 400 }
      );
    }
  }

  const kind = rangeCheck.window ? "range" : mode;

  const progress = getSyncProgress();
  if (progress.running) {
    // A sync is already running — queue this validated request instead of
    // 409ing it away. Dates are kept as the original YYYY-MM-DD strings (not
    // the resolved window), and resume/startPage/startPageBrandId are kept
    // as given (not resolved to a startPages map yet) so the entry replays
    // through the exact same start path — including a fresh per-brand
    // derivation for `resume` — when it's drained (see QueueEntry's doc
    // comment and resolveStartPages).
    const enqueued = enqueueSync({
      kind,
      startPage,
      startPageBrandId,
      resume,
      dateStart,
      dateEnd,
      brandId,
    });
    if (!enqueued.ok) {
      return NextResponse.json(
        {
          error:
            enqueued.reason === "duplicate"
              ? "This exact sync is already queued."
              : `The sync queue is full (max ${MAX_QUEUE_SIZE}) — remove a queued entry or wait for one to start.`,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        queued: true,
        position: enqueued.position,
        entry: enqueued.entry,
        progress: getSyncProgress(),
      },
      { status: 202 }
    );
  }

  // Only the (fast) startPages resolution is awaited here — the run itself
  // stays fire-and-forget below, same as before this feature existed.
  const resolved = rangeCheck.window
    ? null
    : await resolveStartPages({ resume, startPage, startPageBrandId });

  const run = rangeCheck.window
    ? runRangeSync({
        dateStart: rangeCheck.window.start,
        dateEnd: rangeCheck.window.end,
        brandId,
      })
    : mode === "incremental"
      ? runIncrementalSync(resolved!)
      : runFullSync(resolved!);
  // Fire-and-forget: the run updates SyncLog + in-memory progress itself, and
  // advanceQueueAfter auto-advances (or holds) the queue once it settles.
  advanceQueueAfter(run).catch((error) =>
    console.error("Background sync failed:", error)
  );

  // Give the run a beat to register so the response includes a syncLogId.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return NextResponse.json(
    { started: true, mode: kind, progress: getSyncProgress() },
    { status: 202 }
  );
}
