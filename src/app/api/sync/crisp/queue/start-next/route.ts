import { NextResponse } from "next/server";
import { startNextQueuedSync } from "@/lib/sync/sync-service";
import { getSyncProgress } from "@/lib/sync/sync-state";

export const dynamic = "force-dynamic";

/**
 * POST /api/sync/crisp/queue/start-next
 *
 * Manually resumes a HELD queue — see advanceQueueAfter in sync-service.ts:
 * when a running sync is halted by the user (Stop → cancelled, Pause →
 * paused) rather than ending naturally, the queue stops auto-advancing so it
 * doesn't fight the user's "I want control now." This clears that hold and
 * starts the next queued entry (FIFO); once THAT run settles naturally, the
 * rest of the queue auto-advances again as usual.
 *
 * `409` if a sync is already running (shouldn't be possible while the queue
 * is held, but guarded the same way /api/sync/crisp/start is) or the queue
 * is empty.
 */
export async function POST() {
  const result = startNextQueuedSync();
  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          result.reason === "running"
            ? "A sync is already running"
            : "The sync queue is empty",
      },
      { status: 409 }
    );
  }

  // Give the run a beat to register so the response includes a syncLogId,
  // same as /api/sync/crisp/start.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return NextResponse.json(
    { started: true, mode: result.entry.kind, progress: getSyncProgress() },
    { status: 202 }
  );
}
