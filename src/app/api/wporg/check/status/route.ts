import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { computeResumeIndex, getCheckProgress } from "@/lib/wporg/check-state";

export const dynamic = "force-dynamic";

/**
 * GET /api/wporg/check/status
 * Live progress of the current forum check (if any), the 5 most recent
 * ForumCheckLog runs (with errors), the number of checkable plugins (valid
 * Continue range), and the default resume index derived from history.
 */
export async function GET() {
  const [recentLogs, resumeRuns, pluginCount] = await Promise.all([
    prisma.forumCheckLog.findMany({ orderBy: { startedAt: "desc" }, take: 5 }),
    // Resume index is derived from all non-running history (see computeResumeIndex).
    prisma.forumCheckLog.findMany({
      where: { status: { not: "running" } },
      select: { lastIndex: true, status: true },
    }),
    prisma.plugin.count({ where: { wpOrgSlug: { not: null } } }),
  ]);

  return NextResponse.json({
    progress: getCheckProgress(),
    recentLogs,
    resumeIndex: computeResumeIndex(resumeRuns, pluginCount),
    pluginCount,
  });
}
