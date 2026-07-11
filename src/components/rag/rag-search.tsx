"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  ArrowUpRight,
  BookOpen,
  LifeBuoy,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  Search,
  SearchX,
  Sparkles,
  Square,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { StateBadge } from "@/components/state-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Mirrors RagSearchResponse from GET /api/rag/search (server lib types stay server-side). */
type RagSearchMode = "vector" | "hybrid" | "keyword";

type ChunkSource = "crisp_chat" | "plugin_docs" | "wporg_forum";

const SOURCE_META: Record<
  ChunkSource,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  crisp_chat: { label: "Chat", icon: MessagesSquare },
  plugin_docs: { label: "Docs", icon: BookOpen },
  wporg_forum: { label: "Forum Q&A", icon: LifeBuoy },
};

interface RagSearchResult {
  chunkId: string;
  chunkText: string;
  source: ChunkSource;
  product: string | null;
  topic: string | null;
  language: string | null;
  pluginName: string | null;
  similarity: number | null;
  conversation: {
    sessionId: string;
    state: string | null;
    visitorNickname: string | null;
    tags: string[];
    createdAtCrisp: string | null;
  } | null;
  docsPage: {
    url: string;
    title: string | null;
  } | null;
}

interface RagSearchResponse {
  mode: RagSearchMode;
  query: string;
  results: RagSearchResult[];
}

const MODE_META: Record<
  RagSearchMode,
  { label: string; caption: string; className: string }
> = {
  vector: {
    label: "Vector",
    caption: "pgvector similarity",
    className:
      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400",
  },
  hybrid: {
    label: "Hybrid",
    caption: "embedding re-rank",
    className:
      "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-400",
  },
  keyword: {
    label: "Keyword",
    caption: "full-text search",
    className:
      "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-500/30 dark:bg-zinc-500/10 dark:text-zinc-400",
  },
};

const MAX_TAGS = 4;

function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^session_/, "").slice(0, 8);
}

function similarityPercent(similarity: number): number {
  return Math.round(Math.max(0, Math.min(1, similarity)) * 100);
}

/** Progress payload from GET /api/rag/chunks/rebuild. */
interface RebuildProgress {
  running: boolean;
  total: number;
  done: number;
  chunksCreated: number;
  skipped: number;
  purged: number;
  cancelRequested: boolean;
  status: "idle" | "running" | "completed" | "cancelled" | "failed";
}

const REBUILD_IDLE: RebuildProgress = {
  running: false,
  total: 0,
  done: 0,
  chunksCreated: 0,
  skipped: 0,
  purged: 0,
  cancelRequested: false,
  status: "idle",
};

const REBUILD_POLL_INTERVAL_MS = 2500;

/** "Rebuild finished — N chunks from M conversations (X skipped, Y purged)". */
function rebuildSummary(p: RebuildProgress): string {
  const extras: string[] = [];
  if (p.skipped > 0) extras.push(`${p.skipped} skipped`);
  if (p.purged > 0) extras.push(`${p.purged} purged`);
  const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return `Rebuild finished — ${p.chunksCreated} chunks from ${p.done} conversations${suffix}`;
}

export function RagSearch() {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [rebuild, setRebuild] = React.useState<RebuildProgress>(REBUILD_IDLE);
  const [rebuildStarting, setRebuildStarting] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const rebuildWasRunning = React.useRef(false);
  const [response, setResponse] = React.useState<RagSearchResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [source, setSource] = React.useState<ChunkSource | "all">("all");

  const handleSearch = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    try {
      const sourceParam = source === "all" ? "" : `&source=${source}`;
      const res = await fetch(
        `/api/rag/search?query=${encodeURIComponent(trimmed)}&limit=10${sourceParam}`,
        { cache: "no-store" }
      );
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          (data as { error?: string } | null)?.error ?? "Search failed";
        throw new Error(message);
      }
      setResponse(data as RagSearchResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Search failed";
      setResponse(null);
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const pollRebuild = React.useCallback(async () => {
    try {
      const res = await fetch("/api/rag/chunks/rebuild", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as RebuildProgress;
      setRebuild(body);
      if (body.running) {
        rebuildWasRunning.current = true;
      } else if (rebuildWasRunning.current) {
        // The run we were watching finished — summarize and reload the page so
        // dashboard chunk counts refresh.
        rebuildWasRunning.current = false;
        if (body.status === "cancelled") {
          toast.success(
            `Rebuild stopped — processed ${body.done} of ${body.total} conversations`
          );
        } else if (body.status === "failed") {
          toast.error("Rebuild failed — see server logs");
        } else {
          toast.success(rebuildSummary(body));
        }
        router.refresh();
      }
    } catch {
      // Best-effort polling; the next tick retries.
    }
  }, [router]);

  // Poll once on mount so a page reload picks up an in-flight rebuild.
  React.useEffect(() => {
    void pollRebuild();
  }, [pollRebuild]);

  // While a rebuild is active, track its progress every ~2.5s.
  React.useEffect(() => {
    if (!rebuild.running) return;
    const id = setInterval(() => void pollRebuild(), REBUILD_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [rebuild.running, pollRebuild]);

  const handleRebuild = async () => {
    if (rebuild.running || rebuildStarting) return;
    setRebuildStarting(true);
    try {
      const res = await fetch("/api/rag/chunks/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => null)) as {
        started?: boolean;
        error?: string;
      } | null;
      if (res.status === 409) {
        toast.error(data?.error ?? "A full chunk rebuild is already running");
        await pollRebuild();
        return;
      }
      if (!res.ok || !data?.started) {
        toast.error(data?.error ?? "Failed to start chunk rebuild");
        return;
      }
      toast.success("Rebuild started in background");
      rebuildWasRunning.current = true;
      setRebuild({ ...REBUILD_IDLE, running: true, status: "running" });
    } catch {
      toast.error("Failed to start chunk rebuild");
    } finally {
      setRebuildStarting(false);
    }
  };

  const handleStopRebuild = async () => {
    if (rebuild.cancelRequested || stopping) return;
    setStopping(true);
    try {
      const res = await fetch("/api/rag/chunks/rebuild/stop", {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(data.error ?? "Failed to request stop");
        return;
      }
      toast.success("Stop requested — finishing the current conversation");
      await pollRebuild();
    } catch {
      toast.error("Failed to request stop");
    } finally {
      setStopping(false);
    }
  };

  const mode = response ? MODE_META[response.mode] : null;

  return (
    <div className="space-y-6">
      <Card className="gap-4 py-5">
        <CardContent className="space-y-4 px-5">
          <form
            onSubmit={handleSearch}
            className="flex flex-col gap-3 sm:flex-row"
          >
            <div className="relative flex-1">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Ask a support question, e.g. “refund for YayMail annual license”"
                aria-label="Search query"
                className={cn(
                  "placeholder:text-muted-foreground dark:bg-input/30 border-input flex h-11 w-full min-w-0 rounded-md border bg-transparent py-1 pr-3 pl-9 text-base shadow-xs transition-[color,box-shadow] outline-none",
                  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
                )}
                disabled={loading}
              />
            </div>
            <Button
              type="submit"
              disabled={loading || query.trim().length === 0}
              className="h-11 bg-blue-600 px-5 text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700"
            >
              {loading ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Sparkles />
              )}
              Search
            </Button>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <div className="flex items-center gap-1">
              {(
                [
                  ["all", "All sources"],
                  ["crisp_chat", "Chats"],
                  ["plugin_docs", "Docs"],
                  ["wporg_forum", "Forum Q&A"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={source === value ? "secondary" : "ghost"}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => setSource(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRebuild}
                disabled={rebuild.running || rebuildStarting}
              >
                {rebuild.running || rebuildStarting ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {rebuild.running
                  ? `Rebuilding… ${rebuild.done}/${rebuild.total}`
                  : "Rebuild all chunks"}
              </Button>
              {rebuild.running && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleStopRebuild}
                  disabled={rebuild.cancelRequested || stopping}
                  className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
                >
                  {stopping ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Square className="size-3.5" />
                  )}
                  {rebuild.cancelRequested ? "Stopping…" : "Stop"}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {!response && !error && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
          <Sparkles className="text-muted-foreground size-8" />
          <p className="text-sm font-medium">Search the chunk index</p>
          <p className="text-muted-foreground text-sm">
            Try a real support question — e.g. “How do I renew my FileBird
            license?”
          </p>
        </div>
      )}

      {response && mode && (
        <section aria-label="Search results" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground text-sm">
              <span className="text-foreground font-medium tabular-nums">
                {response.results.length}
              </span>{" "}
              {response.results.length === 1 ? "result" : "results"} for{" "}
              <span className="text-foreground font-medium">
                “{response.query}”
              </span>
            </p>
            <Badge variant="outline" className={mode.className}>
              {mode.label}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {mode.caption}
            </span>
          </div>

          {response.results.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
              <SearchX className="text-muted-foreground size-8" />
              <p className="text-sm font-medium">No matching chunks</p>
              <p className="text-muted-foreground text-sm">
                Sync conversations and rebuild chunks first.
              </p>
            </div>
          ) : (
            <ul className="space-y-4">
              {response.results.map((result) => (
                <li key={result.chunkId}>
                  <ResultCard result={result} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function ResultCard({ result }: { result: RagSearchResult }) {
  const { conversation, docsPage } = result;
  const extraTags = conversation ? conversation.tags.length - MAX_TAGS : 0;
  const sourceMeta = SOURCE_META[result.source] ?? SOURCE_META.crisp_chat;
  const SourceIcon = sourceMeta.icon;

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1">
            <SourceIcon className="size-3" />
            {sourceMeta.label}
          </Badge>
          {result.product && (
            <Badge className="border-transparent bg-blue-600 text-white dark:bg-blue-600">
              {result.product}
            </Badge>
          )}
          {result.language && (
            <Badge variant="outline" className="uppercase">
              {result.language}
            </Badge>
          )}
          {result.similarity != null && (
            <Badge variant="secondary" className="tabular-nums">
              {similarityPercent(result.similarity)}% match
            </Badge>
          )}
          {result.topic && (
            <span
              className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
              title={result.topic}
            >
              {result.topic}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-4">
        <pre className="whitespace-pre-wrap text-xs bg-muted rounded-md p-3 max-h-64 overflow-auto font-mono">
          {result.chunkText}
        </pre>
      </CardContent>
      <CardFooter className="border-t px-4 [.border-t]:pt-3">
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          {conversation ? (
            <>
              <Link
                href={`/crisp/conversations/${conversation.sessionId}`}
                className="group text-foreground flex min-w-0 items-center gap-1.5 font-medium transition-colors hover:text-blue-600 dark:hover:text-blue-400"
              >
                <MessagesSquare className="text-muted-foreground size-3.5 transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-400" />
                <span className="truncate">
                  {conversation.visitorNickname ?? "Unknown visitor"}
                </span>
                <span className="text-muted-foreground font-mono">
                  {shortSessionId(conversation.sessionId)}
                </span>
                <ArrowUpRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
              {conversation.createdAtCrisp && (
                <span className="text-muted-foreground">
                  {format(new Date(conversation.createdAtCrisp), "MMM d, yyyy")}
                </span>
              )}
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                <StateBadge state={conversation.state} />
                {conversation.tags.slice(0, MAX_TAGS).map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
                {extraTags > 0 && (
                  <span className="text-muted-foreground">+{extraTags}</span>
                )}
              </span>
            </>
          ) : docsPage ? (
            <a
              href={docsPage.url}
              target="_blank"
              rel="noreferrer"
              className="group text-foreground flex min-w-0 items-center gap-1.5 font-medium transition-colors hover:text-blue-600 dark:hover:text-blue-400"
            >
              <SourceIcon className="text-muted-foreground size-3.5 transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-400" />
              <span className="truncate">
                {docsPage.title ?? docsPage.url}
              </span>
              {result.pluginName && (
                <Badge variant="secondary">{result.pluginName}</Badge>
              )}
              <ArrowUpRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
            </a>
          ) : (
            <span className="text-muted-foreground">Source unavailable</span>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}
