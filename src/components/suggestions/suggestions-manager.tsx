"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  Lightbulb,
  LifeBuoy,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ThreadStatusBadge } from "@/components/state-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ContextChunkItem {
  source: "crisp_chat" | "plugin_docs" | "wporg_forum";
  similarity: number | null;
  title: string;
  link: string | null;
  excerpt: string;
  product: string | null;
}

export interface SuggestionThreadItem {
  id: string;
  title: string;
  url: string;
  author: string | null;
  excerpt: string;
  status: string;
  draftAnswer: string | null;
  draftModel: string | null;
  suggestError: string | null;
  contextChunks: ContextChunkItem[];
  publishedAt: string | null;
  fetchedAt: string;
  plugin: { id: string; name: string };
}

const STATUS_FILTERS = ["all", "new", "drafted", "failed", "reviewed", "dismissed"];
const ALL = "__all__";

export function SuggestionsManager({
  threads,
  plugins,
}: {
  threads: SuggestionThreadItem[];
  plugins: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [checking, setChecking] = React.useState(false);

  const activeStatus = searchParams.get("status") ?? "all";
  const activePlugin = searchParams.get("pluginId") ?? ALL;

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
        `Checked ${body.pluginsChecked} forums — ${body.newThreads} new threads, ${body.drafted} drafts`,
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
          No forum threads yet — set a wp.org slug on your plugins, then click
          “Check forums now”.
        </div>
      ) : (
        threads.map((thread) => <ThreadCard key={thread.id} thread={thread} />)
      )}
    </div>
  );
}

function ThreadCard({ thread }: { thread: SuggestionThreadItem }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

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

  const copyDraft = async () => {
    if (!thread.draftAnswer) return;
    await navigator.clipboard.writeText(thread.draftAnswer);
    setCopied(true);
    toast.success("Draft copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

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

        {thread.draftAnswer ? (
          <div className="rounded-md border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-500/25 dark:bg-violet-500/5">
            <div className="mb-1.5 flex items-center gap-2">
              <Sparkles className="size-3.5 text-violet-600 dark:text-violet-400" />
              <span className="text-xs font-medium text-violet-700 dark:text-violet-400">
                Suggested reply
              </span>
              {thread.draftModel ? (
                <span className="text-muted-foreground font-mono text-[11px]">
                  {thread.draftModel}
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 px-2 text-xs"
                onClick={copyDraft}
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                Copy
              </Button>
            </div>
            <p className="text-sm whitespace-pre-wrap">{thread.draftAnswer}</p>
          </div>
        ) : thread.suggestError ? (
          <p className="text-destructive text-xs">
            Draft failed: {thread.suggestError}
          </p>
        ) : thread.status === "drafted" ? (
          <p className="text-muted-foreground text-xs">
            No LLM provider configured — use the retrieved context below to
            compose a reply (set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable
            drafts).
          </p>
        ) : null}

        {thread.contextChunks.length > 0 ? (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Grounding context
            </p>
            {thread.contextChunks.map((chunk, index) => (
              <div
                key={index}
                className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
              >
                {chunk.source === "plugin_docs" ? (
                  <BookOpen className="text-muted-foreground size-3.5 shrink-0" />
                ) : chunk.source === "wporg_forum" ? (
                  <LifeBuoy className="text-muted-foreground size-3.5 shrink-0" />
                ) : (
                  <MessagesSquare className="text-muted-foreground size-3.5 shrink-0" />
                )}
                {chunk.link ? (
                  chunk.link.startsWith("/") ? (
                    <Link
                      href={chunk.link}
                      className="group inline-flex min-w-0 items-center gap-1 truncate font-medium hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      <span className="truncate">{chunk.title}</span>
                      <ArrowUpRight className="size-3 opacity-0 group-hover:opacity-100" />
                    </Link>
                  ) : (
                    <a
                      href={chunk.link}
                      target="_blank"
                      rel="noreferrer"
                      className="group inline-flex min-w-0 items-center gap-1 truncate font-medium hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      <span className="truncate">{chunk.title}</span>
                      <ArrowUpRight className="size-3 opacity-0 group-hover:opacity-100" />
                    </a>
                  )
                ) : (
                  <span className="truncate font-medium">{chunk.title}</span>
                )}
                {chunk.product ? (
                  <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                    {chunk.product}
                  </Badge>
                ) : null}
                {chunk.similarity != null ? (
                  <span className="text-muted-foreground ml-auto tabular-nums">
                    {Math.round(Math.max(0, Math.min(1, chunk.similarity)) * 100)}%
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

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
            {thread.draftAnswer ? "Regenerate draft" : "Generate draft"}
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
              onClick={() => void setStatus("dismissed", "Thread dismissed")}
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
