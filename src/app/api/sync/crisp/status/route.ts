import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getResumePage,
  getResumePages,
  reconcileStaleSyncRuns,
} from "@/lib/sync/sync-service";
import { getSyncProgress } from "@/lib/sync/sync-state";

export const dynamic = "force-dynamic";

/**
 * GET /api/sync/crisp/status
 * Live progress of the current sync (if any) plus recent sync history.
 */
export async function GET() {
  // Heal any "running" rows orphaned by a server restart BEFORE reading the
  // history — the dashboard polls this route, so an orphan disappears on the
  // next poll instead of reading "Running" forever (and blocking the guard).
  await reconcileStaleSyncRuns();

  const [recentLogs, lastCompleted, resumePage, resumePages] = await Promise.all([
    prisma.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    prisma.syncLog.findFirst({
      where: { status: "completed" },
      orderBy: { finishedAt: "desc" },
    }),
    // Kept alongside resumePages for back-compat — anything still reading
    // the single-number field keeps working unchanged.
    getResumePage(),
    getResumePages(),
  ]);

  return NextResponse.json({
    progress: getSyncProgress(),
    lastCompleted,
    recentLogs,
    resumePage,
    resumePages,
  });
}
