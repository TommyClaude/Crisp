-- Resurface old topics that got a fresh customer reply.
--
-- The wp.org forum feed carries reply items (URLs with a #post-N anchor), not
-- just new topics. When a customer bumps a years-old topic, the watcher now
-- flags the existing thread (or creates one for a customer-last old topic) so
-- it shows up again in Answer Suggestions instead of being silently dropped.
--
--   hasNewReply    — drives the "New reply" badge; cleared on regenerate or a
--                    status change.
--   lastReplyAt    — newest reply date the watcher has already processed for
--                    this thread; lets a later check dedupe cheaply (including
--                    support-team replies, which set this WITHOUT flagging).
--   lastActivityAt — sort key for the "Recent" tab. Backfilled below to the
--                    existing publish/fetch date so old rows sort sensibly;
--                    kept current in code (publishedAt on create, the reply
--                    date on resurface).

-- AlterTable: additive columns on SupportThread.
ALTER TABLE "SupportThread" ADD COLUMN     "hasNewReply" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SupportThread" ADD COLUMN     "lastReplyAt" TIMESTAMP(3);
ALTER TABLE "SupportThread" ADD COLUMN     "lastActivityAt" TIMESTAMP(3);

-- Backfill lastActivityAt for existing rows so the "Recent" ordering has a
-- value to sort on immediately (publish date when known, else fetch date).
UPDATE "SupportThread" SET "lastActivityAt" = COALESCE("publishedAt", "fetchedAt");

-- CreateIndex: the "Recent" tab orders by lastActivityAt desc.
CREATE INDEX "SupportThread_lastActivityAt_idx" ON "SupportThread"("lastActivityAt");

-- AlterTable: per-run count of resurfaced topics for the ForumCheckLog history.
ALTER TABLE "ForumCheckLog" ADD COLUMN     "resurfaced" INTEGER NOT NULL DEFAULT 0;
