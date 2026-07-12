"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  EllipsisVertical,
  ExternalLink,
  Lightbulb,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { HelpTip } from "@/components/help-tip";
import {
  FollowupDueBadge,
  NewReplyBadge,
  NoResponseBadge,
  ThreadStatusBadge,
  WaitingOnCustomerBadge,
} from "@/components/state-badge";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  activeTabValue,
  DEFAULT_TAB,
  emptyStateMessage,
  NEEDS_REPLY,
  NEEDS_RESOLVED,
  SUGGESTION_TABS,
} from "@/lib/suggest/suggestions-view";

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
  // A customer posted a fresh reply on this (possibly old) topic — drives the
  // "New reply" badge. Cleared on regenerate or a status change.
  hasNewReply: boolean;
  // Days since an overdue support-team follow-up promise (null when there is no
  // promise, or it is still within the grace period) — drives the amber
  // "Follow-up due" badge. Gating is computed server-side.
  promiseDueDays: number | null;
  // Whole days the topic has been waiting on the customer (support replied last,
  // no promise), or null when not waiting. Drives the waiting badge; whether it
  // reads amber or muted is decided by silenceOverThreshold.
  waitingDays: number | null;
  // True once waitingDays has passed WPORG_SILENCE_NUDGE_DAYS — the topic is in
  // "Needs resolved" and shows the amber "No response · Nd" badge; false shows
  // the muted "Waiting on customer" badge. Computed server-side.
  silenceOverThreshold: boolean;
  publishedAt: string | null;
  fetchedAt: string;
  plugin: { id: string; name: string };
}

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

/** Live progress payload from GET /api/wporg/check/status → progress. */
interface CheckProgress {
  running: boolean;
  phase: "feeds" | "drafting";
  pluginsTotal: number;
  pluginsDone: number;
  currentIndex: number | null;
  currentPlugin: string | null;
  currentFeedTopics: number | null;
  newThreads: number;
  drafted: number;
  draftsDone: number;
  skippedOld: number;
  resurfaced: number;
  startedAt: string | null;
  cancelRequested: boolean;
  cancelReason: "cancelled" | "paused";
}

/** A ForumCheckLog row serialized for the client (powers the last-check line). */
export interface ForumCheckLogView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  pluginsChecked: number;
  newThreads: number;
  drafted: number;
  skippedOld: number;
  resurfaced: number;
  lastIndex: number | null;
  errors: string[];
}

interface CheckStatusResponse {
  progress: CheckProgress;
  recentLogs: ForumCheckLogView[];
  resumeIndex: number;
  pluginCount: number;
}

const CHECK_POLL_INTERVAL_MS = 2500;

/** Statuses the bulk generator considers (matches the API's eligibility). */
const BULK_ELIGIBLE_STATUSES = ["new", "drafted", "failed"];

/** Terminal check statuses that offer a "Continue" affordance. */
const HALTED_STATUSES = ["paused", "cancelled", "failed"];

function pluralTopics(n: number): string {
  return `${n} new ${n === 1 ? "topic" : "topics"}`;
}

/** Parse the "continue from" input into a valid 1-based index. */
function clampIndex(raw: string, max: number): number {
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return max > 0 ? Math.min(parsed, max) : parsed;
}

export function SuggestionsManager({
  threads,
  plugins,
  llmConfigured,
  totalThreadCount,
  tabCounts,
  initialCheckProgress,
  initialLastCheck,
  initialResumeIndex,
  pluginCount: initialPluginCount,
}: {
  threads: SuggestionThreadItem[];
  plugins: Array<{ id: string; name: string }>;
  llmConfigured: boolean;
  /** Count of ALL support topics in the DB (ignoring filters) — distinguishes
   *  a truly empty DB (onboarding hint) from an empty filtered view. */
  totalThreadCount: number;
  /** Topic count per tab (`?status=` value → count), scoped by the active
   *  plugin filter with the same where-clauses each tab's list query uses —
   *  rendered as a muted chip on each tab button. */
  tabCounts: Record<string, number>;
  initialCheckProgress: CheckProgress;
  initialLastCheck: ForumCheckLogView | null;
  initialResumeIndex: number;
  pluginCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [bulk, setBulk] = React.useState<BulkDraftProgress>(BULK_IDLE);
  const [bulkStarting, setBulkStarting] = React.useState(false);
  const bulkWasRunning = React.useRef(false);

  // Accordion cards are collapsed by default (empty set = none expanded). The
  // kebab's Expand/Collapse all and each card's chevron toggle membership here.
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(
    () => new Set()
  );
  const toggleExpanded = React.useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const expandAll = React.useCallback(
    () => setExpandedIds(new Set(threads.map((t) => t.id))),
    [threads]
  );
  const collapseAll = React.useCallback(() => setExpandedIds(new Set()), []);

  // Forum-check progress: seeded from the server so an in-flight check (this
  // tab, another tab, or one started before navigation) shows with no flash,
  // then kept live by polling GET /api/wporg/check/status.
  const [checkProgress, setCheckProgress] =
    React.useState<CheckProgress>(initialCheckProgress);
  const [lastCheck, setLastCheck] = React.useState<ForumCheckLogView | null>(
    initialLastCheck
  );
  const [checkStarting, setCheckStarting] = React.useState<
    "start" | "continue" | null
  >(null);
  const [halting, setHalting] = React.useState<"pause" | "stop" | null>(null);
  const [showCheckErrors, setShowCheckErrors] = React.useState(false);
  const [pluginCount, setPluginCount] = React.useState(initialPluginCount);
  // Furthest index reached across history — the default "Continue from" point.
  const [resumeIndex, setResumeIndex] = React.useState(initialResumeIndex);
  // Kept as a string so the field edits freely; clamped on blur and on start.
  const [resumeFrom, setResumeFrom] = React.useState(String(initialResumeIndex));
  const checkWasRunning = React.useRef(initialCheckProgress.running);
  const checkRunning = checkProgress.running;

  // Track the computed resume index until the user edits the field.
  React.useEffect(() => {
    setResumeFrom(String(resumeIndex));
  }, [resumeIndex]);

  // Whether the most recent finished run halted (paused/cancelled/failed) and
  // can be continued.
  const halted =
    !checkRunning && lastCheck !== null && HALTED_STATUSES.includes(lastCheck.status);

  const activeTab = activeTabValue(searchParams.get("status"));
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

  const refreshCheckStatus = React.useCallback(async () => {
    try {
      const res = await fetch("/api/wporg/check/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as CheckStatusResponse;
      setCheckProgress(data.progress);
      if (typeof data.pluginCount === "number") setPluginCount(data.pluginCount);
      if (typeof data.resumeIndex === "number") setResumeIndex(data.resumeIndex);
      const lastFinished =
        data.recentLogs.find((log) => log.status !== "running") ?? null;
      if (lastFinished) setLastCheck(lastFinished);
      const nowRunning = Boolean(data.progress.running);
      if (checkWasRunning.current && !nowRunning) {
        // A check we were watching just finished — summarize and reload.
        const verb =
          lastFinished && lastFinished.status !== "completed"
            ? lastFinished.status
            : "finished";
        toast.success(
          lastFinished
            ? `Forum check ${verb} — ${lastFinished.newThreads} new, ${lastFinished.drafted} drafted, ${lastFinished.skippedOld} skipped`
            : "Forum check finished"
        );
        router.refresh();
      }
      checkWasRunning.current = nowRunning;
    } catch {
      // Best-effort polling; the next tick may succeed.
    }
  }, [router]);

  // Pick up an already-running check on mount (started elsewhere or before nav).
  React.useEffect(() => {
    void refreshCheckStatus();
  }, [refreshCheckStatus]);

  // Poll while a check is running.
  React.useEffect(() => {
    if (!checkRunning) return;
    const id = setInterval(() => void refreshCheckStatus(), CHECK_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [checkRunning, refreshCheckStatus]);

  const startCheck = async (opts: {
    key: "start" | "continue";
    startIndex?: number;
    label: string;
  }) => {
    setCheckStarting(opts.key);
    try {
      const res = await fetch("/api/wporg/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          withSuggestions: true,
          ...(opts.startIndex ? { startIndex: opts.startIndex } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.error("A forum check is already running");
        if (body.progress) setCheckProgress(body.progress);
        checkWasRunning.current = true;
        return;
      }
      if (!res.ok) {
        toast.error(body.error ?? "Forum check failed");
        return;
      }
      if (body.progress) setCheckProgress(body.progress);
      checkWasRunning.current = true;
      toast.success(`${opts.label} started`);
    } catch {
      toast.error("Forum check failed");
    } finally {
      setCheckStarting(null);
    }
  };

  const haltCheck = async (action: "pause" | "stop") => {
    setHalting(action);
    try {
      const res = await fetch("/api/wporg/check/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pause: action === "pause" }),
      });
      if (!res.ok) {
        toast.error(`Failed to request ${action}`);
        return;
      }
      toast.success(action === "pause" ? "Pause requested" : "Stop requested", {
        description: "The check will halt after the current plugin.",
      });
      await refreshCheckStatus();
    } catch {
      toast.error(`Failed to request ${action}`);
    } finally {
      setHalting(null);
    }
  };

  const checkBusy = checkRunning || checkStarting !== null;
  const haltRequested = checkProgress.cancelRequested;

  // Button label only names the current phase — plugin index, plugin name and
  // counters live in the progress line right below, so repeating them here
  // would duplicate (and truncate) the same text.
  const checkLabel =
    checkProgress.phase === "drafting" ? "Drafting replies…" : "Checking plugins…";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {SUGGESTION_TABS.map((tab) => (
            <React.Fragment key={tab.value}>
              <Button
                size="sm"
                variant={activeTab === tab.value ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-xs"
                onClick={() =>
                  // The default tab clears the param for a clean URL.
                  setParam("status", tab.value === DEFAULT_TAB ? null : tab.value)
                }
              >
                {tab.label}
                <span className="text-muted-foreground text-xs tabular-nums">
                  {tabCounts[tab.value] ?? 0}
                </span>
              </Button>
              {tab.value === NEEDS_REPLY ? (
                <HelpTip subject="the Needs reply tab" className="mr-1">
                  Your work queue: every topic still waiting on a human — no
                  draft yet, a draft to review, or a failed draft — plus anything
                  flagged for attention even after review: a fresh customer
                  reply, or a support follow-up your team promised and hasn&rsquo;t
                  posted. Topics waiting on the customer and dismissed topics
                  never appear here.
                </HelpTip>
              ) : tab.value === NEEDS_RESOLVED ? (
                <HelpTip subject="the Needs resolved tab" className="mr-1">
                  Topics where your team posted the last reply and the customer
                  has gone quiet for several days. They can probably be closed —
                  open one and use Regenerate to draft a gentle closing reply
                  that still invites them to reopen if anything is unresolved.
                </HelpTip>
              ) : null}
            </React.Fragment>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {plugins.length > 0 ? (
            <Select
              value={activePlugin}
              onValueChange={(v) => setParam("pluginId", v)}
            >
              <SelectTrigger size="sm" className="w-auto min-w-40 max-w-56">
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
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={threads.length === 0}
                  onSelect={expandAll}
                >
                  <ChevronsUpDown className="size-3.5" />
                  Expand all
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={threads.length === 0}
                  onSelect={collapseAll}
                >
                  <ChevronsDownUp className="size-3.5" />
                  Collapse all
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {checkRunning ? (
            <>
              <span className="text-muted-foreground inline-flex max-w-[18rem] items-center gap-1.5 text-xs">
                <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
                <span className="truncate">{checkLabel}</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => haltCheck("pause")}
                disabled={haltRequested || halting !== null}
                className="border-amber-200 text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:border-amber-500/30 dark:text-amber-400 dark:hover:bg-amber-500/10"
              >
                {halting === "pause" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Pause className="size-3.5" />
                )}
                {haltRequested && checkProgress.cancelReason === "paused"
                  ? "Pausing…"
                  : "Pause"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => haltCheck("stop")}
                disabled={haltRequested || halting !== null}
                className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
              >
                {halting === "stop" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3.5" />
                )}
                {haltRequested && checkProgress.cancelReason !== "paused"
                  ? "Stopping…"
                  : "Stop"}
              </Button>
            </>
          ) : halted ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={checkBusy}
                onClick={() =>
                  void startCheck({ key: "start", label: "Forum check" })
                }
              >
                {checkStarting === "start" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                Check from start
              </Button>
              <Input
                type="number"
                min={1}
                max={pluginCount || undefined}
                step={1}
                value={resumeFrom}
                disabled={checkBusy}
                onChange={(e) => setResumeFrom(e.target.value)}
                onBlur={() =>
                  setResumeFrom(String(clampIndex(resumeFrom, pluginCount)))
                }
                aria-label="Continue from plugin number (alphabetical order)"
                title={`Continue from plugin # (alphabetical order, 1–${pluginCount || "?"})`}
                className="h-8 w-16 tabular-nums"
              />
              <HelpTip subject="the continue index">
                The alphabetical plugin index to resume from — plugin 1 is the
                first alphabetically, not the first ever checked. Used to
                pick up a paused, cancelled, or failed check partway through.
              </HelpTip>
              <Button
                size="sm"
                disabled={checkBusy}
                onClick={() =>
                  void startCheck({
                    key: "continue",
                    startIndex: clampIndex(resumeFrom, pluginCount),
                    label: "Continue",
                  })
                }
              >
                {checkStarting === "continue" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={checkBusy}
                onClick={() =>
                  void startCheck({ key: "start", label: "Forum check" })
                }
              >
                {checkStarting ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                Check forums now
              </Button>
              <HelpTip subject="Check forums now">
                Reads each plugin&rsquo;s wp.org support-forum feed, saves any
                topics posted in the last 30 days (configurable) that
                aren&rsquo;t already tracked, and drafts AI reply suggestions
                for the new ones.
              </HelpTip>
            </>
          )}
        </div>
      </div>

      {checkRunning ? (
        <div className="text-muted-foreground -mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          {checkProgress.phase === "drafting" ? (
            <span>
              Drafting replies {checkProgress.draftsDone}/
              {checkProgress.newThreads}
            </span>
          ) : (
            <span>
              Checking plugin {checkProgress.currentIndex ?? checkProgress.pluginsDone}{" "}
              of {checkProgress.pluginsTotal}
              {checkProgress.currentPlugin
                ? ` — ${checkProgress.currentPlugin}`
                : ""}
              {checkProgress.currentFeedTopics != null
                ? ` (${checkProgress.currentFeedTopics} in feed)`
                : ""}
            </span>
          )}
          <span aria-hidden>·</span>
          <span>{checkProgress.newThreads} new</span>
          <span aria-hidden>·</span>
          <span>{checkProgress.resurfaced} resurfaced</span>
          <span aria-hidden>·</span>
          <span>{checkProgress.drafted} drafted</span>
          <span aria-hidden>·</span>
          <span>{checkProgress.skippedOld} skipped (old)</span>
        </div>
      ) : null}

      {lastCheck ? (
        <div className="-mt-2 space-y-1">
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            <span suppressHydrationWarning>
              Last check{" "}
              {formatDistanceToNow(
                new Date(lastCheck.finishedAt ?? lastCheck.startedAt),
                { addSuffix: true }
              )}
            </span>
            <span aria-hidden>—</span>
            <span>{pluralTopics(lastCheck.newThreads)}</span>
            {lastCheck.resurfaced > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span>{lastCheck.resurfaced} resurfaced</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>{lastCheck.drafted} drafted</span>
            <span aria-hidden>·</span>
            <span>{lastCheck.skippedOld} skipped (old)</span>
            {lastCheck.status === "failed" ? (
              <>
                <span aria-hidden>·</span>
                <span className="text-destructive">check failed</span>
              </>
            ) : lastCheck.status === "paused" || lastCheck.status === "cancelled" ? (
              <>
                <span aria-hidden>·</span>
                <span className="text-amber-600 dark:text-amber-400">
                  {lastCheck.status}
                  {lastCheck.lastIndex != null
                    ? ` at plugin ${lastCheck.lastIndex}/${pluginCount || "?"}`
                    : ""}{" "}
                  — continue below (numbering is alphabetical)
                </span>
              </>
            ) : null}
            {lastCheck.errors.length > 0 ? (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => setShowCheckErrors((v) => !v)}
                  title={lastCheck.errors.join("\n")}
                  aria-expanded={showCheckErrors}
                  className="inline-flex items-center gap-0.5 text-amber-600 underline-offset-2 hover:underline dark:text-amber-400"
                >
                  <TriangleAlert className="size-3" />
                  {lastCheck.errors.length} error
                  {lastCheck.errors.length === 1 ? "" : "s"}
                </button>
              </>
            ) : null}
          </div>
          {showCheckErrors && lastCheck.errors.length > 0 ? (
            <ul className="text-muted-foreground space-y-0.5 border-l-2 border-amber-300 pl-3 text-xs dark:border-amber-500/40">
              {lastCheck.errors.map((err, i) => (
                <li key={i} className="break-words">
                  {err}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {threads.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          <Lightbulb className="mx-auto mb-2 size-6 opacity-60" />
          {emptyStateMessage({
            tab: activeTab,
            totalInDb: totalThreadCount,
            pluginFilterActive: activePlugin !== ALL,
          })}
        </div>
      ) : (
        threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            llmConfigured={llmConfigured}
            expanded={expandedIds.has(thread.id)}
            onToggle={() => toggleExpanded(thread.id)}
          />
        ))
      )}
    </div>
  );
}

/** Collapsed one-liner: what's inside the card without opening it. */
function summarizeThread(thread: SuggestionThreadItem): string {
  const parts: string[] = [];
  const draftCount = thread.drafts.filter((draft) => draft.text).length;
  if (draftCount > 0) {
    parts.push(`${draftCount} draft${draftCount === 1 ? "" : "s"}`);
  }
  if (thread.followup?.drafts.some((draft) => draft.text)) {
    parts.push("follow-up");
  }
  if (thread.contextChunks.length > 0) {
    parts.push(`${thread.contextChunks.length} context`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No drafts yet";
}

function ThreadCard({
  thread,
  llmConfigured,
  expanded,
  onToggle,
}: {
  thread: SuggestionThreadItem;
  llmConfigured: boolean;
  expanded: boolean;
  onToggle: () => void;
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
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse topic" : "Expand topic"}
            className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0 rounded transition-colors"
          >
            {expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ThreadStatusBadge status={thread.status} />
              {thread.hasNewReply ? <NewReplyBadge /> : null}
              {thread.promiseDueDays != null ? (
                <FollowupDueBadge days={thread.promiseDueDays} />
              ) : null}
              {thread.waitingDays != null ? (
                thread.silenceOverThreshold ? (
                  <NoResponseBadge days={thread.waitingDays} />
                ) : (
                  <WaitingOnCustomerBadge />
                )
              ) : null}
              <Badge variant="secondary">{thread.plugin.name}</Badge>
              {thread.publishedAt ? (
                <span
                  className="text-muted-foreground text-xs"
                  suppressHydrationWarning
                >
                  {formatDistanceToNow(new Date(thread.publishedAt), {
                    addSuffix: true,
                  })}
                </span>
              ) : null}
              {thread.author ? (
                <span className="text-muted-foreground text-xs">
                  by {thread.author}
                </span>
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
            {!expanded ? (
              <p className="text-muted-foreground text-xs">
                {summarizeThread(thread)}
              </p>
            ) : null}
          </div>
        </div>
      </CardHeader>

      {expanded ? (
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
            populated by the manual Regenerate action. "Draft anyway" on a
            support-last skip forces a promise-delivering follow-up. */}
        {thread.followup ? (
          <FollowupSection
            followup={thread.followup}
            noResponseDays={thread.waitingDays}
            onDraftAnyway={() =>
              void call(
                "draft-anyway",
                () =>
                  fetch(`/api/wporg/threads/${thread.id}/suggest`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ forceFollowup: true }),
                  }),
                "Follow-up drafted"
              )
            }
            draftAnywayLoading={busy === "draft-anyway"}
            draftAnywayDisabled={busy !== null}
          />
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
      ) : null}
    </Card>
  );
}
