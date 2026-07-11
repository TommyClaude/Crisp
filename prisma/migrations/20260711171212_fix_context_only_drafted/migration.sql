-- Data repair: a SupportThread must only carry status='drafted' when at
-- least one provider draft has non-empty text. Before this fix, threads
-- suggested while no LLM provider was configured were saved with the
-- retrieved RAG context only (draftsJson: [], draftAnswer: null) but still
-- marked "drafted" — showing a "Drafted" badge on the dashboard/Suggestions
-- list for topics that have no actual draft, while "Generate missing
-- drafts" simultaneously counted them as missing.
--
-- This flips those rows back to status='new'. The predicate is defensive
-- about draftsJson's shape (NULL, non-array, or an array whose entries
-- carry no non-empty "text") so it only touches genuinely context-only
-- rows — it deliberately leaves alone any row where draftsJson already
-- contains a non-empty draft text, even if draftAnswer itself is NULL.
--
-- Verified against the dev DB by seeding disposable rows covering every
-- case (empty-array draftsJson, NULL draftsJson, blank-text entries, a
-- real draft, status=failed/new/reviewed) and confirming only the three
-- context-only rows matched before applying for real.
UPDATE "SupportThread"
SET status = 'new'
WHERE status = 'drafted'
  AND "draftAnswer" IS NULL
  AND (
    "draftsJson" IS NULL
    OR jsonb_typeof("draftsJson") IS DISTINCT FROM 'array'
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements("draftsJson") AS elem
      WHERE COALESCE(elem ->> 'text', '') <> ''
    )
  );
