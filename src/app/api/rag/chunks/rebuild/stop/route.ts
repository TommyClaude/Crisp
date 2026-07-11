import { NextResponse } from "next/server";
import {
  getRebuildProgress,
  requestRebuildCancel,
} from "@/lib/rag/rebuild-state";

export const dynamic = "force-dynamic";

/**
 * POST /api/rag/chunks/rebuild/stop
 *
 * Requests graceful cancellation of the running full rebuild. The loop finishes
 * the conversation in flight, keeps the work already committed, and records the
 * run as "cancelled". 409 when nothing is running. Mirrors
 * src/app/api/sync/crisp/stop/route.ts.
 */
export async function POST() {
  const requested = requestRebuildCancel();
  if (!requested) {
    return NextResponse.json(
      { error: "No rebuild is currently running" },
      { status: 409 }
    );
  }
  return NextResponse.json({
    stopping: true,
    progress: getRebuildProgress(),
  });
}
