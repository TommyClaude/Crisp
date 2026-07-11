"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Check,
  EllipsisVertical,
  ExternalLink,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ThreadStatusBadge } from "@/components/state-badge";
import {
  ContextChunkList,
  DraftCards,
  DraftErrorLines,
  FollowupSection,
  type ContextChunkItem,
  type DraftItemView,
  type FollowupView,
} from "@/components/suggestions/draft-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Re-exported so existing importers (e.g. app/suggestions/page.tsx) keep their
// current import paths after the shared extraction.
export type { ContextChunkItem, DraftItemView, FollowupView };

export interface SuggestionThreadItem {
  id: string;
  title: string;
  url: string;
  author: string | null;
  excerpt: string;
  status: string;
  drafts: DraftItemView[];
  suggestError: string | null;
  contextChunks: ContextChunkItem[];
  // Present once the manual Regenerate action has drafted a follow-up reply
  // (or recorded why it was skipped); null until then.
  followup: FollowupView | null;
  publishedAt: string | null;
  fetchedAt: string;
  plugin: { id: string; name: string };
}

const STATUS_FILTERS = ["all", "new", "drafted", "failed", "reviewed", "dismissed"];
const ALL = "__all__";

/** Progress payload from GET /api/wporg/suggest-missing. */
interface BulkDraftProgress {
  running: boolean;
  total: number;
  done: number;
  drafted: number;
  failed: number;
}

const BULK_IDLE: BulkDraftProgress = {
  running: false,
  total: 0,
  done: 0,
  drafted: 0,
  failed: 0,
};

/** Statuses the bulk generator considers (matches the API's eligibility). */
const BULK_ELIGIBLE_STATUSES = ["new", "drafted", "failed"];

export function SuggestionsManager({
  threads,
  plugins,
  llmConfigured,
}: {
  threads: SuggestionThreadItem[];
  plugins: Array<{ id: string; name: string }>;
  llmConfigured: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [checking, setChecking] = React.useState(false);
  const [bulk, setBulk] = React.useState<BulkDraftProgress>(BULK_IDLE);
  const [bulkStarting, setBulkStarting] = React.useState(false);
  const bulkWasRunning = React.useRef(false);

  const activeStatus = searchParams.get("status") ?? "all";
  const activePlugin = searchParams.get("pluginId") ?? ALL;

  // Topics in view with no draft text yet — same rule the bulk API applies.
  const missingCount = threads.filter(
    (thread) =>
      BULK_ELIGIBLE_STATUSES.includes(thread.status) &&
      !thread.drafts.some((draft) => draft.text)
  ).length;

  const pollBulk = React.useCallback(async () => {
    try {
      const res = await fetch("/api/wporg/suggest-missing", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as BulkDraftProgress;
      setBulk(body);
      if (body.running) {
        bulkWasRunning.current = true;
      } else if (bulkWasRunning.current) {
        // The run we were watching finished — summarize and reload the list.
        bulkWasRunning.current = false;
        toast.success(
          `Draft generation finished — ${body.drafted} drafted, ${body.failed} failed`
        );
        router.refresh();
      }
    } catch {
      // Best-effort polling; the next tick retries.
    }
  }, [router]);

  // Poll once on mount so a page reload picks up an in-flight bulk run.
  React.useEffect(() => {
    void pollBulk();
  }, [pollBulk]);

  // While a bulk run is active, track its progress every 3s.
  React.useEffect(() => {
    if (!bulk.running) return;
    const id = setInterval(() => void pollBulk(), 3000);
    return () => clearInterval(id);
  }, [bulk.running, pollBulk]);

  const generateMissingDrafts = async () => {
    setBulkStarting(true);
    try {
      const res = await fetch("/api/wporg/suggest-missing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          activePlugin === ALL ? {} : { pluginId: activePlugin }
        ),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to start draft generation");
        return;
      }
      if (!body.queued) {
        toast.success("No topics are missing drafts");
        return;
      }
      toast.success(
        `Generating drafts for ${body.queued} topics in the background…`
      );
      bulkWasRunning.current = true;
      setBulk({
        running: true,
        total: body.queued,
        done: 0,
        drafted: 0,
        failed: 0,
      });
    } catch {
      toast.error("Failed to start draft generation");
    } finally {
      setBulkStarting(false);
    }
  };

  const setParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === "" || value === "all" || value === ALL) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const checkForums = async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/wporg/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ withSuggestions: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Forum check failed");
        return;
      }
      toast.success(
        `Checked ${body.pluginsChecked} forums — ${body.newThreads} new topics, ${body.drafted} drafts`,
        {
          description:
            body.errors?.length > 0 ? `${body.errors.length} feed error(s) — see server logs` : undefined,
        }
      );
      router.refresh();
    } catch {
      toast.error("Forum check failed");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={activeStatus === status ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs capitalize"
              onClick={() => setParam("status", status)}
            >
              {status}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {plugins.length > 0 ? (
            <Select
              value={activePlugin}
              onValueChange={(v) => setParam("pluginId", v)}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue placeholder="All plugins" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All plugins</SelectItem>
                {plugins.map((plugin) => (
                  <SelectItem key={plugin.id} value={plugin.id}>
                    {plugin.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {bulk.running || bulkStarting ? (
            // A run is active — keep the same progress affordance visible in
            // the toolbar (there's no stop/cancel action to preserve; the
            // bulk generator has none). The kebab reappears once it's done.
            <Button size="sm" variant="outline" disabled>
              <LoaderCircle className="size-3.5 animate-spin" />
              {bulk.running ? `Drafting… ${bulk.done}/${bulk.total}` : "Starting…"}
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="outline"
                  className="size-8"
                  aria-label="More actions"
                >
                  <EllipsisVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  disabled={missingCount === 0 || !llmConfigured}
                  onSelect={() => void generateMissingDrafts()}
                >
                  <div className="flex flex-col gap-0.5 py-0.5">
                    <span className="flex items-center gap-2">
                      <Sparkles className="size-3.5" />
                      {`Generate missing drafts (${missingCount})`}
                    </span>
                    {missingCount === 0 ? (
                      <span className="text-muted-foreground text-xs">
                        No topics are missing a draft
                      </span>
                    ) : !llmConfigured ? (
                      <span className="text-muted-foreground text-xs">
                        No LLM provider configured — set ANTHROPIC_API_KEY or
                        OPENAI_API_KEY
                      </span>
                    ) : null}
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button size="sm" onClick={checkForums} disabled={checking}>
            {checking ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Check forums now
          </Button>
        </div>
      </div>

      {threads.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          <Lightbulb className="mx-auto mb-2 size-6 opacity-60" />
          No forum topics yet — set a wp.org slug on your plugins, then click
          “Check forums now”.
        </div>
      ) : (
        threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            llmConfigured={llmConfigured}
          />
        ))
      )}
    </div>
  );
}

function ThreadCard({
  thread,
  llmConfigured,
}: {
  thread: SuggestionThreadItem;
  llmConfigured: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const draftsWithText = thread.drafts.filter((draft) => draft.text);

  const call = async (
    key: string,
    request: () => Promise<Response>,
    successMessage: string
  ) => {
    setBusy(key);
    try {
      const res = await request();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Request failed");
        return;
      }
      toast.success(successMessage);
      router.refresh();
    } catch {
      toast.error("Request failed");
    } finally {
      setBusy(null);
    }
  };

  const setStatus = (status: string, message: string) =>
    call(
      `status-${status}`,
      () =>
        fetch(`/api/wporg/threads/${thread.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }),
      message
    );

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ThreadStatusBadge status={thread.status} />
          <Badge variant="secondary">{thread.plugin.name}</Badge>
          {thread.publishedAt ? (
            <span className="text-muted-foreground text-xs" suppressHydrationWarning>
              {formatDistanceToNow(new Date(thread.publishedAt), { addSuffix: true })}
            </span>
          ) : null}
          {thread.author ? (
            <span className="text-muted-foreground text-xs">by {thread.author}</span>
          ) : null}
        </div>
        <CardTitle className="text-sm leading-snug">
          <a
            href={thread.url}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-start gap-1 hover:text-blue-600 dark:hover:text-blue-400"
          >
            {thread.title}
            <ExternalLink className="mt-0.5 size-3.5 shrink-0 opacity-50 group-hover:opacity-100" />
          </a>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3 px-4">
        {thread.excerpt ? (
          <p className="text-muted-foreground line-clamp-3 text-xs whitespace-pre-wrap">
            {thread.excerpt}
          </p>
        ) : null}

        {draftsWithText.length > 0 ? (
          <DraftCards drafts={thread.drafts} />
        ) : thread.suggestError ? (
          <p className="text-destructive text-xs">
            Draft failed: {thread.suggestError}
          </p>
        ) : thread.status === "new" ? (
          <p className="text-muted-foreground text-xs">
            {llmConfigured
              ? "No drafts yet — click Generate drafts to create suggestions from your configured AI providers."
              : "No LLM provider configured — use the retrieved context below to compose a reply (set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable drafts)."}
          </p>
        ) : null}

        {/* When some providers succeeded and others errored, surface the
            per-provider failures below the drafts that did land. */}
        {draftsWithText.length > 0 ? (
          <DraftErrorLines drafts={thread.drafts} />
        ) : null}

        {/* Follow-up reply (the next reply for the whole thread) — only
            populated by the manual Regenerate action. */}
        {thread.followup ? (
          <FollowupSection followup={thread.followup} />
        ) : null}

        <ContextChunkList chunks={thread.contextChunks} />

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void call(
                "suggest",
                () =>
                  fetch(`/api/wporg/threads/${thread.id}/suggest`, {
                    method: "POST",
                  }),
                "Suggestion regenerated"
              )
            }
          >
            {busy === "suggest" ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {draftsWithText.length > 0 ? "Regenerate drafts" : "Generate drafts"}
          </Button>
          {thread.status !== "reviewed" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void setStatus("reviewed", "Marked as reviewed")}
            >
              <Check className="size-3.5" />
              Mark reviewed
            </Button>
          ) : null}
          {thread.status !== "dismissed" ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={busy !== null}
              onClick={() => void setStatus("dismissed", "Topic dismissed")}
            >
              <X className="size-3.5" />
              Dismiss
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
