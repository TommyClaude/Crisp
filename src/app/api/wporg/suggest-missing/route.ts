import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getBulkDraftProgress,
  isBulkDraftRunning,
  startBulkDraftRun,
} from "@/lib/suggest/bulk";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ pluginId: z.string().optional() }).default({});

/**
 * POST /api/wporg/suggest-missing
 * Body: { pluginId?: string }
 * Starts a background bulk run that drafts suggestions for every topic with
 * no draft text yet (status new/drafted/failed). Returns 202 {started,
 * queued}, 200 {queued: 0} when nothing is missing, 409 while a run is
 * already active. Poll GET for progress.
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

  if (isBulkDraftRunning()) {
    return NextResponse.json(
      { error: "A bulk draft run is already running" },
      { status: 409 }
    );
  }

  try {
    const { queued } = await startBulkDraftRun(parsed.data);
    if (queued === 0) return NextResponse.json({ queued: 0 });
    return NextResponse.json({ started: true, queued }, { status: 202 });
  } catch (error) {
    // startBulkDraftRun throws "already running" when a concurrent start won
    // the race between our guard check above and the claim inside.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already running")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    console.error("Bulk draft start failed:", error);
    return NextResponse.json(
      { error: "Bulk draft start failed", detail: String(error) },
      { status: 500 }
    );
  }
}

/** GET /api/wporg/suggest-missing — progress of the current/last bulk run. */
export async function GET() {
  return NextResponse.json(getBulkDraftProgress());
}
