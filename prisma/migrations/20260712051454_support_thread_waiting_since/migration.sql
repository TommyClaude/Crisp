-- SupportThread.waitingSince: set when the watcher sees a support-team reply as
-- the newest post WITHOUT a follow-up promise (the ball is with the customer);
-- cleared when the customer replies, the thread's status changes, or a promise
-- supersedes it. Drives the "Waiting on customer" state and, once older than
-- WPORG_SILENCE_NUDGE_DAYS, the "Needs resolved" tab.
--
-- SupportThread.wpResolved: the topic's resolution flag as shown on
-- wordpress.org, refreshed whenever we fetch the live topic page. false when
-- unknown (bias toward surfacing). A topic already marked resolved on wp.org is
-- excluded from the "Needs resolved" tab.

-- AlterTable
ALTER TABLE "SupportThread" ADD COLUMN     "waitingSince" TIMESTAMP(3);
ALTER TABLE "SupportThread" ADD COLUMN     "wpResolved" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "SupportThread_waitingSince_idx" ON "SupportThread"("waitingSince");

-- Backfill already-tracked threads whose last known state was team-replied-last:
-- the follow-up drafter recorded a "support_last" skip, no fresh customer reply
-- is pending (hasNewReply = false), and no promise is armed. Start the waiting
-- clock at the last reply date so these surface correctly right away.
UPDATE "SupportThread"
SET "waitingSince" = "lastReplyAt"
WHERE "followupJson"->>'skipped' = 'support_last'
  AND "hasNewReply" = false
  AND "followupPromisedAt" IS NULL
  AND "lastReplyAt" IS NOT NULL
  AND "status" <> 'dismissed';
