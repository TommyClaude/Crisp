import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSyncProgress, removeQueueEntry } from "@/lib/sync/sync-state";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  id: z.string().min(1),
});

/**
 * POST /api/sync/crisp/queue/remove
 * Body: { id }
 *
 * Removes one entry from the in-memory sync queue (see /api/sync/crisp/start
 * for how a validated request joins the queue while a sync is running).
 * `404` if `id` isn't currently queued — it may already have started (the
 * queue drained it), already been removed, or the server restarted since
 * (the queue is process-memory only, like the rest of sync progress).
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

  const removed = removeQueueEntry(parsed.data.id);
  if (!removed) {
    return NextResponse.json(
      { error: `No queued sync with id ${parsed.data.id}` },
      { status: 404 }
    );
  }

  return NextResponse.json({ removed: true, progress: getSyncProgress() });
}
