import { prisma } from "@/lib/db";
import { isCheckRunning } from "./check-state";

/**
 * Grace window before {@link reconcileStaleForumChecks} closes an orphaned
 * "running" ForumCheckLog row — same rationale as the sync-side
 * reconcileStaleSyncRuns: a cron `npm run wporg:check` in another process is
 * invisible to this one, and normally finishes inside the window.
 */
const RECONCILE_GRACE_MS = 10 * 60 * 1000;

/**
 * Close out "running" ForumCheckLog rows that no longer correspond to a live
 * check. Check progress lives in process memory (check-state.ts), so a server
 * restart mid-check leaves its log row "running" forever — cosmetically wrong
 * in the recent-checks list, and excluded from the resume-index history (the
 * furthest-plugin progress it recorded is real and should count). Called from
 * the check status route, which the suggestions page polls, so orphans heal
 * on the next view. Unlike the sync side there is no DB single-flight guard
 * to unblock — this is purely log/resume hygiene.
 */
export async function reconcileStaleForumChecks(): Promise<number> {
  if (isCheckRunning()) return 0;
  const graceBefore = new Date(Date.now() - RECONCILE_GRACE_MS);
  const result = await prisma.forumCheckLog.updateMany({
    where: { status: "running", startedAt: { lt: graceBefore } },
    data: {
      status: "failed",
      finishedAt: new Date(),
      errors: {
        push: "Interrupted: the server restarted while this check was in flight. Topics processed up to that point are saved.",
      },
    },
  });
  return result.count;
}
