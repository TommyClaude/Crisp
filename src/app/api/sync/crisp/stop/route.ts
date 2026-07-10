import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSyncProgress, requestSyncCancel } from "@/lib/sync/sync-state";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    // Pause records the run as "paused" (resumable via "Continue from page N");
    // Stop records it as "cancelled". Both halt gracefully after the page.
    pause: z.boolean().default(false),
  })
  .default({ pause: false });

/**
 * POST /api/sync/crisp/stop
 * Body: { pause?: boolean }
 *
 * Requests graceful cancellation of the currently running sync. The run
 * finishes the conversation in flight, persists page-level progress, and
 * marks the SyncLog as "paused" (pause) or "cancelled" (stop). Either way
 * the run can be continued from its last page.
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

  const reason = parsed.data.pause ? "paused" : "cancelled";
  const requested = requestSyncCancel(reason);
  if (!requested) {
    return NextResponse.json(
      { error: "No sync is currently running" },
      { status: 409 }
    );
  }
  return NextResponse.json({
    stopping: true,
    reason,
    progress: getSyncProgress(),
  });
}
