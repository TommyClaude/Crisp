import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSyncProgress } from "@/lib/sync/sync-state";

export const dynamic = "force-dynamic";

/**
 * GET /api/sync/crisp/status
 * Live progress of the current sync (if any) plus recent sync history.
 */
export async function GET() {
  const [recentLogs, lastCompleted] = await Promise.all([
    prisma.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    prisma.syncLog.findFirst({
      where: { status: "completed" },
      orderBy: { finishedAt: "desc" },
    }),
  ]);

  return NextResponse.json({
    progress: getSyncProgress(),
    lastCompleted,
    recentLogs,
  });
}
