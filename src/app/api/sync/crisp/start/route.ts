import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runFullSync, runIncrementalSync } from "@/lib/sync/sync-service";
import { getSyncProgress } from "@/lib/sync/sync-state";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    mode: z.enum(["full", "incremental"]).default("full"),
    startPage: z.coerce.number().int().min(1).optional(),
  })
  .default({ mode: "full" });

/**
 * POST /api/sync/crisp/start
 * Body: { mode?: "full" | "incremental", startPage?: number }
 *
 * Kicks off a background sync in this server process and returns immediately.
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

  const progress = getSyncProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "A sync is already running", progress },
      { status: 409 }
    );
  }

  const { mode, startPage } = parsed.data;
  const run =
    mode === "incremental"
      ? runIncrementalSync({ startPage })
      : runFullSync({ startPage });
  // Fire-and-forget: the run updates SyncLog + in-memory progress itself.
  run.catch((error) => console.error("Background sync failed:", error));

  // Give the run a beat to register so the response includes a syncLogId.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return NextResponse.json(
    { started: true, mode, progress: getSyncProgress() },
    { status: 202 }
  );
}
