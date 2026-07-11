import { prisma } from "@/lib/db";
import {
  SuggestionsManager,
  type DraftItemView,
  type FollowupView,
  type SuggestionThreadItem,
} from "@/components/suggestions/suggestions-manager";
import type { FollowupResult } from "@/lib/suggest/followup";
import { suggesterConfigured } from "@/lib/suggest/llm";
import type { ContextChunkSummary, DraftItem } from "@/lib/suggest/suggester";

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

  const [threads, plugins] = await Promise.all([
    prisma.supportThread.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(pluginId ? { pluginId } : {}),
      },
      include: { plugin: { select: { id: true, name: true, wpOrgSlug: true } } },
      orderBy: [
        { publishedAt: { sort: "desc", nulls: "last" } },
        { fetchedAt: "desc" },
      ],
      take: 50,
    }),
    prisma.plugin.findMany({
      where: { wpOrgSlug: { not: null } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

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
      />
    </div>
  );
}
