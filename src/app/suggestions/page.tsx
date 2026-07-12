import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getEnv } from "@/env";
import {
  SuggestionsManager,
  type DraftItemView,
  type FollowupView,
  type ForumCheckLogView,
  type SuggestionThreadItem,
} from "@/components/suggestions/suggestions-manager";
import type { FollowupResult } from "@/lib/suggest/followup";
import { suggesterConfigured } from "@/lib/suggest/llm";
import {
  daysSincePromise,
  daysSinceWaiting,
  isPromiseDue,
  isSilenceNudgeDue,
  promiseDueCutoff,
  silenceNudgeCutoff,
  sortNeedsReplyRows,
} from "@/lib/suggest/promise";
import type { ContextChunkSummary, DraftItem } from "@/lib/suggest/suggester";
import {
  NEEDS_REPLY,
  NEEDS_RESOLVED,
  needsReplyBacklogWhere,
  needsReplyFlaggedWhere,
  needsReplyWhere,
  needsResolvedWhere,
  RECENT,
  resolveTab,
} from "@/lib/suggest/suggestions-view";
import { computeResumeIndex, getCheckProgress } from "@/lib/wporg/check-state";

export const dynamic = "force-dynamic";

export default async function SuggestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const pluginId = first(sp.pluginId);
  const tab = resolveTab(first(sp.status));

  const env = getEnv();
  const reminderDays = env.WPORG_PROMISE_REMINDER_DAYS;
  const nudgeDays = env.WPORG_SILENCE_NUDGE_DAYS;
  const now = new Date();
  const promiseCutoff = promiseDueCutoff(reminderDays, now);
  const silenceCutoff = silenceNudgeCutoff(nudgeDays, now);
  const pluginWhere: Prisma.SupportThreadWhereInput = pluginId
    ? { pluginId }
    : {};

  const threadInclude = {
    plugin: { select: { id: true, name: true, wpOrgSlug: true } },
  } as const;
  const activityOrder: Prisma.SupportThreadOrderByWithRelationInput[] = [
    { lastActivityAt: { sort: "desc", nulls: "last" } },
    { fetchedAt: "desc" },
  ];

  // Per-tab query shape:
  //  - "needs-reply" (default): the work queue, fetched as two DISJOINT halves
  //    so the page cap can never drop a flagged row — a promise-due topic with
  //    an old lastActivityAt must survive any number of fresher backlog rows
  //    (with one capped query it silently vanished past 50 rows). The JS pass
  //    below finishes the flagged-first ordering.
  //  - "needs-resolved": silent topics waiting on the customer past the nudge
  //    threshold, longest-waiting first (waitingSince asc).
  //  - "recent": browse-all, floated by fresh activity (lastActivityAt).
  //  - a real status: that status only, keeping the publish-date ordering.
  const fetchThreads =
    tab.kind === "needs-reply"
      ? Promise.all([
          prisma.supportThread.findMany({
            where: { ...needsReplyFlaggedWhere(promiseCutoff), ...pluginWhere },
            include: threadInclude,
            orderBy: activityOrder,
            take: 50,
          }),
          prisma.supportThread.findMany({
            where: { ...needsReplyBacklogWhere(promiseCutoff), ...pluginWhere },
            include: threadInclude,
            orderBy: activityOrder,
            take: 50,
          }),
        ]).then(([flagged, backlog]) => [...flagged, ...backlog])
      : tab.kind === "needs-resolved"
        ? prisma.supportThread.findMany({
            where: { ...needsResolvedWhere(silenceCutoff), ...pluginWhere },
            include: threadInclude,
            // Longest-waiting first — the topics most overdue for a close.
            orderBy: [{ waitingSince: { sort: "asc", nulls: "last" } }],
            take: 50,
          })
        : tab.kind === "recent"
          ? prisma.supportThread.findMany({
              where: pluginWhere,
              include: threadInclude,
              orderBy: activityOrder,
              take: 50,
            })
          : prisma.supportThread.findMany({
              where: { status: tab.status, ...pluginWhere },
              include: threadInclude,
              orderBy: [
                { publishedAt: { sort: "desc", nulls: "last" } },
                { fetchedAt: "desc" },
              ],
              take: 50,
            });

  // Per-tab topic counts for the tab row, scoped by the same plugin filter
  // and using the exact same where-clauses as each tab's list query above.
  // Needs-reply is counted via needsReplyWhere — the documented union of
  // needsReplyFlaggedWhere + needsReplyBacklogWhere — rather than summing two
  // counts: same result (the two halves are disjoint by construction), one
  // query. Batched into a single Promise.all so the 7 counts run concurrently
  // (and concurrently with everything else below).
  const tabCountEntries: Array<[string, Prisma.SupportThreadWhereInput]> = [
    [NEEDS_REPLY, { ...needsReplyWhere(promiseCutoff), ...pluginWhere }],
    [NEEDS_RESOLVED, { ...needsResolvedWhere(silenceCutoff), ...pluginWhere }],
    [RECENT, { ...pluginWhere }],
    ["new", { status: "new", ...pluginWhere }],
    ["failed", { status: "failed", ...pluginWhere }],
    ["reviewed", { status: "reviewed", ...pluginWhere }],
    ["dismissed", { status: "dismissed", ...pluginWhere }],
  ];
  const tabCountsPromise: Promise<Record<string, number>> = Promise.all(
    tabCountEntries.map(([, where]) => prisma.supportThread.count({ where }))
  ).then((counts) =>
    Object.fromEntries(tabCountEntries.map(([key], i) => [key, counts[i]]))
  );

  const [threads, plugins, lastCheckLog, resumeRuns, totalThreadCount, tabCounts] =
    await Promise.all([
    fetchThreads,
    prisma.plugin.findMany({
      where: { wpOrgSlug: { not: null } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    // Most recent finished check, for the last-check summary line.
    prisma.forumCheckLog.findFirst({
      where: { status: { not: "running" } },
      orderBy: { startedAt: "desc" },
    }),
    // Non-running history, for the default Continue index.
    prisma.forumCheckLog.findMany({
      where: { status: { not: "running" } },
      select: { lastIndex: true, status: true },
    }),
    // Whole-DB topic count (ignoring filters) — lets the client show the
    // onboarding hint ONLY when there are genuinely no topics, versus a
    // per-tab / "no match" message for an empty filtered view.
    prisma.supportThread.count(),
    tabCountsPromise,
  ]);

  // Finish the Needs-reply ordering in JS (flagged-first; the DB did the coarse
  // pass): promise-due can't be a plain orderBy column, so this refines it.
  const orderedThreads =
    tab.kind === "needs-reply"
      ? sortNeedsReplyRows(threads, reminderDays, now)
      : threads;

  // The live progress singleton is shared with the API route in this process,
  // so a check already running (this tab, another tab, or before navigation)
  // renders without a flash.
  const initialCheckProgress = getCheckProgress();
  const initialLastCheck: ForumCheckLogView | null = lastCheckLog
    ? {
        id: lastCheckLog.id,
        startedAt: lastCheckLog.startedAt.toISOString(),
        finishedAt: lastCheckLog.finishedAt?.toISOString() ?? null,
        status: lastCheckLog.status,
        pluginsChecked: lastCheckLog.pluginsChecked,
        newThreads: lastCheckLog.newThreads,
        drafted: lastCheckLog.drafted,
        skippedOld: lastCheckLog.skippedOld,
        resurfaced: lastCheckLog.resurfaced,
        lastIndex: lastCheckLog.lastIndex,
        errors: lastCheckLog.errors,
      }
    : null;
  const pluginCount = plugins.length;
  const initialResumeIndex = computeResumeIndex(resumeRuns, pluginCount);

  const items: SuggestionThreadItem[] = orderedThreads.map((thread) => {
    // New rows carry per-provider drafts in draftsJson; older rows only have
    // the single draftAnswer/draftModel — synthesize a one-item list for them
    // so both render through the same path.
    const stored = (thread.draftsJson as unknown as DraftItem[] | null) ?? null;
    const drafts: DraftItemView[] =
      stored && stored.length > 0
        ? stored.map((draft) => ({
            provider: draft.provider,
            model: draft.model,
            text: draft.text,
            error: draft.error,
          }))
        : thread.draftAnswer
          ? [
              {
                provider: null,
                model: thread.draftModel,
                text: thread.draftAnswer,
                error: null,
              },
            ]
          : [];

    // Follow-up drafts exist only after a manual Regenerate; surface either
    // its drafts or the reason it was skipped.
    const storedFollowup =
      (thread.followupJson as unknown as FollowupResult | null) ?? null;
    const followup: FollowupView | null = storedFollowup
      ? {
          postCount: storedFollowup.postCount,
          skipped: storedFollowup.skipped ?? null,
          mode: storedFollowup.mode ?? null,
          drafts: (storedFollowup.drafts ?? []).map((draft) => ({
            provider: draft.provider,
            model: draft.model,
            text: draft.text,
            error: draft.error,
          })),
        }
      : null;

    return {
      id: thread.id,
      title: thread.title,
      url: thread.url,
      author: thread.author,
      excerpt: thread.excerpt,
      status: thread.status,
      drafts,
      suggestError: thread.suggestError,
      contextChunks:
        (thread.contextJson as unknown as ContextChunkSummary[]) ?? [],
      followup,
      hasNewReply: thread.hasNewReply,
      // Only surfaces once the promise is past the grace period; days drives the
      // badge tooltip. null means no badge (unarmed or still within grace).
      promiseDueDays: isPromiseDue(thread.followupPromisedAt, reminderDays, now)
        ? daysSincePromise(thread.followupPromisedAt!, now)
        : null,
      // Waiting on the customer (support replied last, no promise). waitingDays
      // is null when not waiting; otherwise it's whole days since the clock
      // started and drives a badge — amber "No response · Nd" once past the
      // nudge threshold, muted "Waiting on customer" while still under it.
      waitingDays: thread.waitingSince
        ? daysSinceWaiting(thread.waitingSince, now)
        : null,
      silenceOverThreshold: isSilenceNudgeDue(
        thread.waitingSince,
        nudgeDays,
        now
      ),
      publishedAt: thread.publishedAt?.toISOString() ?? null,
      fetchedAt: thread.fetchedAt.toISOString(),
      plugin: { id: thread.plugin.id, name: thread.plugin.name },
    };
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Answer Suggestions
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          New topics from the wp.org support forums of your plugins, with
          reply drafts grounded in past conversations and docs. Review, copy,
          post — nothing is posted automatically.
        </p>
      </div>
      <SuggestionsManager
        threads={items}
        plugins={plugins}
        llmConfigured={suggesterConfigured()}
        totalThreadCount={totalThreadCount}
        tabCounts={tabCounts}
        initialCheckProgress={initialCheckProgress}
        initialLastCheck={initialLastCheck}
        initialResumeIndex={initialResumeIndex}
        pluginCount={pluginCount}
      />
    </div>
  );
}
