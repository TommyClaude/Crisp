-- Backfill waitingSince for threads whose "support replied last" state was
-- recorded by the Regenerate path rather than the feed watcher. Regenerate
-- knows WHO replied last but not WHEN, so lastReplyAt can be NULL there and
-- the original backfill (20260712051454) skipped those rows. Fall back to the
-- follow-up's own generatedAt: the moment the app first observed the
-- support-last state. Idempotent (waitingSince IS NULL guard).
UPDATE "SupportThread"
SET "waitingSince" = COALESCE("lastReplyAt", ("followupJson"->>'generatedAt')::timestamptz)
WHERE "followupJson"->>'skipped' = 'support_last'
  AND "hasNewReply" = false
  AND "followupPromisedAt" IS NULL
  AND "waitingSince" IS NULL
  AND "status" <> 'dismissed'
  AND COALESCE("lastReplyAt", ("followupJson"->>'generatedAt')::timestamptz) IS NOT NULL;
