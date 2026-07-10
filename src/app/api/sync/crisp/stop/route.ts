import { NextResponse } from "next/server";
import { getSyncProgress, requestSyncCancel } from "@/lib/sync/sync-state";

export const dynamic = "force-dynamic";

/**
 * POST /api/sync/crisp/stop
 * Requests graceful cancellation of the currently running sync. The run
 * finishes the conversation in flight, persists progress, and marks the
 * SyncLog as "cancelled".
 */
export async function POST() {
  const requested = requestSyncCancel();
  if (!requested) {
    return NextResponse.json(
      { error: "No sync is currently running" },
      { status: 409 }
    );
  }
  return NextResponse.json({ stopping: true, progress: getSyncProgress() });
}
