-- One-time cleanup of the stale support-topic backlog.
--
-- Quiet wp.org forums keep years-old topics in their RSS feed, so historically
-- the watcher saved (and drafted for) topics far older than anyone would act
-- on. Task 1 adds a check-time age cutoff so this never happens again; this
-- migration removes the pre-existing backlog once, at `prisma migrate deploy`.
--
-- The 30-day interval is hardcoded (env vars are not available in migrations)
-- and mirrors the WPORG_TOPIC_MAX_AGE_DAYS default at the time this was
-- written. All statuses are included — the user does not want topics older
-- than the cutoff at all. Rows with a NULL publishedAt are kept (their age is
-- unknown).
DELETE FROM "SupportThread"
WHERE "publishedAt" IS NOT NULL
  AND "publishedAt" < NOW() - INTERVAL '30 days';
