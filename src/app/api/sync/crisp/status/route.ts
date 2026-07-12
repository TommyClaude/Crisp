import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getResumePage,
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

  const [recentLogs, lastCompleted, resumePage] = await Promise.all([
    prisma.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    prisma.syncLog.findFirst({
      where: { status: "completed" },
      orderBy: { finishedAt: "desc" },
    }),
    getResumePage(),
  ]);

  return NextResponse.json({
    progress: getSyncProgress(),
    lastCompleted,
    recentLogs,
    resumePage,
  });
}
