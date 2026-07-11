import { prisma } from "@/lib/db";
import {
  SuggestionsManager,
  type DraftItemView,
  type FollowupView,
  type ForumCheckLogView,
  type SuggestionThreadItem,
} from "@/components/suggestions/suggestions-manager";
import type { FollowupResult } from "@/lib/suggest/followup";
import { suggesterConfigured } from "@/lib/suggest/llm";
import type { ContextChunkSummary, DraftItem } from "@/lib/suggest/suggester";
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
  const status = first(sp.status);
  const pluginId = first(sp.pluginId);

  // Per-tab ordering: the no-filter "Recent" tab floats topics with fresh
  // activity (new replies) to the top via lastActivityAt; every status tab
  // (including "New") keeps the publish-date ordering it had before.
  const orderBy = status
    ? [
        { publishedAt: { sort: "desc" as const, nulls: "last" as const } },
        { fetchedAt: "desc" as const },
      ]
    : [
        { lastActivityAt: { sort: "desc" as const, nulls: "last" as const } },
        { fetchedAt: "desc" as const },
      ];

  const [threads, plugins, lastCheckLog, resumeRuns] = await Promise.all([
    prisma.supportThread.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(pluginId ? { pluginId } : {}),
      },
      include: { plugin: { select: { id: true, name: true, wpOrgSlug: true } } },
      orderBy,
      take: 50,
    }),
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
  ]);

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

  const items: SuggestionThreadItem[] = threads.map((thread) => {
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
        initialCheckProgress={initialCheckProgress}
        initialLastCheck={initialLastCheck}
        initialResumeIndex={initialResumeIndex}
        pluginCount={pluginCount}
      />
    </div>
  );
}
