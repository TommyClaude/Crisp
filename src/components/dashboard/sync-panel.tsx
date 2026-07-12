"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  CalendarRange,
  History,
  ListOrdered,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Square,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import {
  SyncLogTable,
  type SerializedSyncLog,
} from "@/components/dashboard/sync-log-table";
import { HelpTip } from "@/components/help-tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Mirrors sync-state.ts's QueueEntry — one validated start request waiting
 *  behind the running sync (dates kept as YYYY-MM-DD strings). */
interface QueuedSyncEntry {
  id: string;
  kind: "full" | "incremental" | "single" | "range";
  startPage?: number;
  startPageBrandId?: string;
  resume?: boolean;
  dateStart?: string;
  dateEnd?: string;
  brandId?: string;
  queuedAt: string;
}

/** Mirrors the shape returned by GET /api/sync/crisp/status → progress. */
interface SyncProgress {
  running: boolean;
  kind: "full" | "incremental" | "single" | "range" | null;
  currentPage: number | null;
  conversationsSynced: number;
  messagesSynced: number;
  failedSessions: string[];
  startedAt: string | null;
  lastSessionId: string | null;
  statusMessage: string | null;
  cancelRequested: boolean;
  cancelReason?: "cancelled" | "paused";
  /** Range-run verification (kind === "range"); zero/null otherwise. */
  range?: {
    start: string | null;
    end: string | null;
    seen: number;
    inByUpdated: number;
    inByCreated: number;
    stoppedEarly: boolean;
  };
  /** FIFO queue of requests waiting behind the running sync (max 5). */
  queue: QueuedSyncEntry[];
  /** True when the queue is held after a Stop/Pause — see sync-state.ts. */
  held: boolean;
}

/** Plain-language one-liner for a queued entry, for the "Queued" list. */
function formatQueueEntry(
  entry: QueuedSyncEntry,
  brands: Array<{ id: string; name: string }>
): string {
  if (entry.kind === "range") {
    const brandName = entry.brandId
      ? (brands.find((b) => b.id === entry.brandId)?.name ?? "removed brand")
      : "all brands";
    return `Range — ${brandName}, ${entry.dateStart} → ${entry.dateEnd}`;
  }
  const label = entry.kind === "incremental" ? "Incremental" : "Full";
  const overrideBrandName = entry.startPageBrandId
    ? (brands.find((b) => b.id === entry.startPageBrandId)?.name ?? "removed brand")
    : null;
  if (entry.resume) {
    return entry.startPage
      ? `${label} — resume (override: page ${entry.startPage}${
          overrideBrandName ? ` for ${overrideBrandName}` : ""
        })`
      : `${label} — resume`;
  }
  if (entry.startPage) {
    return overrideBrandName
      ? `${label} from page ${entry.startPage} (${overrideBrandName})`
      : `${label} from page ${entry.startPage}`;
  }
  return label;
}

/** Compact "Brand → page" summary across every configured brand, e.g.
 *  "YayCommerce → 164 · Ninja Team → 37" — shown instead of a single resume
 *  number once more than one brand is configured, since each brand now
 *  resumes independently (see resumePages / getResumePages). */
function formatResumePagesSummary(
  resumePages: Record<string, number>,
  brands: Array<{ id: string; name: string }>
): string {
  return brands.map((b) => `${b.name} → ${resumePages[b.id] ?? 1}`).join(" · ");
}

/** A month cell click from the coverage heatmap, to prefill the range form. */
export interface PrefillRange {
  start: string;
  end: string;
  /**
   * Which brand's grid the click came from — undefined when the click came
   * from the legacy merged (no-Brand-rows) grid, which has no brand to
   * attribute. In "All brands" mode this carries the specific brand even
   * though no brand is selected in the URL, so the range sync it feeds still
   * targets just that one brand (see the effective-brand resolution below).
   */
  brandId?: string;
  /** Changes on every click so re-selecting the same month re-applies it. */
  nonce: number;
}

/** ISO datetime → YYYY-MM-DD for compact display. */
function isoToDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "?";
}

/** One-line verification summary for a finished range run. */
function formatRangeVerification(progress: SyncProgress): string {
  const r = progress.range;
  if (!r) return "Range sync finished.";
  if (r.seen === 0) {
    return r.stoppedEarly
      ? "Range sync stopped early: the first page fell outside the range — Crisp's date filter may be ignored."
      : "Range sync finished — no conversations in this range.";
  }
  const early = r.stoppedEarly
    ? " · stopped early (a full page fell outside the range)"
    : "";
  return `In range by last-activity: ${r.inByUpdated}/${r.seen}, by created: ${r.inByCreated}/${r.seen}${early}`;
}

interface StatusResponse {
  progress: SyncProgress;
  lastCompleted: SerializedSyncLog | null;
  recentLogs: SerializedSyncLog[];
  resumePage: number;
  resumePages: Record<string, number>;
}

export interface LastSyncSummary {
  finishedAt: string | null;
  status: string;
  kind: string;
  conversationsSynced: number;
  messagesSynced: number;
}

interface SyncPanelProps {
  lastSync: LastSyncSummary | null;
  recentLogs: SerializedSyncLog[];
  /** The furthest page any past sync run has reached (see getResumePage). Kept for back-compat; resumePages is per-brand. */
  resumePage: number;
  /** Each configured brand's own furthest page across history, keyed by brand id — or "default" for the legacy env-only fallback (see getResumePages). Object key order is createdAt asc, so the first key is "the first brand". */
  resumePages: Record<string, number>;
  /** Set when a heatmap month cell is clicked, to prefill the range form. */
  prefillRange?: PrefillRange | null;
  /** Every configured brand, for the recent-runs badge and the range-sync brand label. */
  brands: Array<{ id: string; name: string }>;
  /** The brand scoped by the URL's ?brand= selector, or undefined for "All brands". */
  selectedBrandId?: string;
}

const numberFormat = new Intl.NumberFormat("en-US");

const POLL_INTERVAL_MS = 2000;

/** Parse a "resume from" text input into a valid page number (integer >= 1). */
function clampResumePage(raw: string): number {
  const parsed = Math.trunc(Number(raw));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export function SyncPanel({
  lastSync,
  recentLogs,
  resumePage: initialResumePage,
  resumePages: initialResumePages,
  prefillRange,
  brands,
  selectedBrandId,
}: SyncPanelProps) {
  const router = useRouter();
  const [progress, setProgress] = React.useState<SyncProgress | null>(null);
  const [logs, setLogs] = React.useState<SerializedSyncLog[]>(recentLogs);
  const [last, setLast] = React.useState<LastSyncSummary | null>(lastSync);
  // Date-range sync inputs (YYYY-MM-DD). Prefilled by clicking a heatmap month.
  const [rangeStart, setRangeStart] = React.useState("");
  const [rangeEnd, setRangeEnd] = React.useState("");
  // Which brand a heatmap month click came from (see PrefillRange.brandId) —
  // only relevant in "All brands" mode, where selectedBrandId is undefined
  // but a click still targets one specific brand's grid.
  const [clickBrandId, setClickBrandId] = React.useState<string | undefined>(
    undefined
  );
  const rangeFormRef = React.useRef<HTMLDivElement>(null);
  // The furthest page any past run has reached, across all sync history —
  // kept for back-compat (the single-number "Earlier runs reached" line when
  // 0-1 brands are configured). resumePages is the per-brand source of truth.
  const [resumePage, setResumePage] = React.useState(initialResumePage);
  const [resumePages, setResumePages] = React.useState(initialResumePages);
  // Object key order matches getResumePages' orderedBrandKeys (createdAt
  // asc) — the first key is always "the first brand" (see its doc comment).
  const firstBrandKey = React.useMemo(
    () => Object.keys(resumePages)[0],
    [resumePages]
  );
  // Which brand the manual override input targets: the URL-selected brand
  // when one is chosen, else the first brand — matching the Continue flow's
  // "override targets that brand automatically" behavior.
  const targetBrandKey = selectedBrandId ?? firstBrandKey;
  const targetResumePage = targetBrandKey ? (resumePages[targetBrandKey] ?? 1) : 1;
  // Kept as a string so the field can be freely edited (including a brief
  // empty state) without fighting the user on every keystroke; parsed and
  // clamped to an integer >= 1 on blur and again right before starting.
  const [resumeFrom, setResumeFrom] = React.useState(String(targetResumePage));
  // True once the user has actually typed in the resume-from input — a
  // prefill (from a fresh status poll, or the initial per-brand default) is
  // NOT an edit. Only an edited value is sent as an explicit startPage
  // override; otherwise Continue relies entirely on `resume: true` (see
  // startSync below).
  const [resumeDirty, setResumeDirty] = React.useState(false);
  const [starting, setStarting] = React.useState<
    "full" | "incremental" | "resume" | "range" | null
  >(null);
  const [halting, setHalting] = React.useState<"pause" | "stop" | null>(null);
  const [running, setRunning] = React.useState(false);
  const runningRef = React.useRef(false);
  // Which queued entry is mid-removal (disables just that entry's ✕), and
  // whether "Start next" is in flight (disables just that button).
  const [removingQueueId, setRemovingQueueId] = React.useState<string | null>(
    null
  );
  const [startingNext, setStartingNext] = React.useState(false);

  // The input tracks the latest computed resume page for its target brand
  // until the user edits it (see resumeDirty).
  React.useEffect(() => {
    if (!resumeDirty) setResumeFrom(String(targetResumePage));
  }, [targetResumePage, resumeDirty]);

  // Apply a heatmap month click to the range inputs and scroll them into view.
  React.useEffect(() => {
    if (!prefillRange) return;
    setRangeStart(prefillRange.start);
    setRangeEnd(prefillRange.end);
    setClickBrandId(prefillRange.brandId);
    rangeFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [prefillRange]);

  // The brand the NEXT range sync should target: the URL-selected brand when
  // one is chosen (wins regardless of which grid a click came from — with one
  // brand selected there's only that one grid anyway), otherwise whichever
  // brand's grid the most recent month click came from ("All brands" mode).
  // Neither set (typed dates, or a click on the legacy merged grid) means
  // every brand, same as before this feature existed.
  const effectiveBrandId = selectedBrandId ?? clickBrandId;
  const effectiveBrandName = effectiveBrandId
    ? (brands.find((b) => b.id === effectiveBrandId)?.name ?? "removed brand")
    : null;

  // The most recent run that isn't still running. When it didn't complete
  // (paused/cancelled/failed — a failed run included, so a bad token never
  // hides the continue affordance) offer to continue the backfill, using the
  // resume page derived from the FURTHEST page reached across all history,
  // not just this run's own page.
  // Range runs are excluded: the "Continue" affordance resumes a full/
  // incremental backfill by page number, which is meaningless for a filtered
  // range walk — and resuming a paused range run as an unbounded full sync is
  // exactly the footgun the range feature exists to avoid. A paused range run
  // is simply re-run from the (idempotent) range form.
  const latestHalted = React.useMemo(() => {
    const latest = logs.find(
      (log) => log.status !== "running" && log.kind !== "range"
    );
    if (!latest || latest.status === "completed") return null;
    return latest;
  }, [logs]);
  // Where this specific run itself stopped (for the "Interrupted at" copy) —
  // may be behind resumePage if an earlier run got further. Deliberately
  // kept as the run's own legacy pageTo/pageFrom (not that run's own
  // brandPages broken out by brand) — this line names ONE page for the
  // run that was actually interrupted, and a single number stays the least
  // surprising phrasing for "where THIS run stopped"; the per-brand summary
  // right after it (see formatResumePagesSummary below) is where per-brand
  // detail belongs.
  const latestHaltedPage = latestHalted
    ? (latestHalted.pageTo ?? latestHalted.pageFrom ?? 1)
    : null;

  const refreshStatus = React.useCallback(async () => {
    try {
      const res = await fetch("/api/sync/crisp/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as StatusResponse;
      setProgress(data.progress);
      if (Array.isArray(data.recentLogs)) setLogs(data.recentLogs);
      if (typeof data.resumePage === "number") setResumePage(data.resumePage);
      if (data.resumePages && typeof data.resumePages === "object") {
        setResumePages(data.resumePages);
      }
      if (data.lastCompleted) {
        setLast({
          finishedAt: data.lastCompleted.finishedAt,
          status: data.lastCompleted.status,
          kind: data.lastCompleted.kind,
          conversationsSynced: data.lastCompleted.conversationsSynced,
          messagesSynced: data.lastCompleted.messagesSynced,
        });
      }
      const nowRunning = Boolean(data.progress?.running);
      if (runningRef.current && !nowRunning) {
        // A sync we were watching just finished — refresh server data. A range
        // run reports its by-both-bases verification line instead of the raw
        // status message.
        const finished = data.progress;
        toast.info("Sync finished", {
          description:
            finished?.kind === "range"
              ? formatRangeVerification(finished)
              : (finished?.statusMessage ?? undefined),
        });
        router.refresh();
      }
      runningRef.current = nowRunning;
      setRunning(nowRunning);
    } catch {
      // Transient network error — keep polling; the next tick may succeed.
    }
  }, [router]);

  // Pick up an already-running sync on mount.
  React.useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Poll every 2s while a sync is running.
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refreshStatus(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [running, refreshStatus]);

  const startSync = async (opts: {
    key: "full" | "incremental" | "resume";
    mode: "full" | "incremental";
    startPage?: number;
    startPageBrandId?: string;
    resume?: boolean;
    label: string;
  }) => {
    setStarting(opts.key);
    try {
      const res = await fetch("/api/sync/crisp/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: opts.mode,
          ...(opts.resume ? { resume: true } : {}),
          ...(opts.startPage != null ? { startPage: opts.startPage } : {}),
          ...(opts.startPageBrandId ? { startPageBrandId: opts.startPageBrandId } : {}),
        }),
      });
      if (res.status === 409) {
        // Queue-specific 409 (duplicate/full) — a plain "already running"
        // 409 shouldn't happen anymore since a running sync now queues a
        // valid request instead, but the message still applies if it does.
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(data?.error ?? "A sync is already running");
        await refreshStatus();
        return;
      }
      if (!res.ok) {
        toast.error("Failed to start sync");
        return;
      }
      const data = (await res.json()) as {
        progress?: SyncProgress;
        queued?: boolean;
      };
      if (data.queued) {
        toast.info("Queued — will start after the current sync", {
          description: `${opts.label} will start automatically once the running sync finishes.`,
        });
        await refreshStatus();
        return;
      }
      if (data.progress) setProgress(data.progress);
      runningRef.current = true;
      setRunning(true);
      toast.success(`${opts.label} started`);
    } catch {
      toast.error("Failed to start sync");
    } finally {
      setStarting(null);
    }
  };

  const startRangeSync = async () => {
    if (!rangeStart || !rangeEnd) {
      toast.error("Pick a From and To date first");
      return;
    }
    if (rangeStart > rangeEnd) {
      toast.error("From date must be on or before To date");
      return;
    }
    setStarting("range");
    try {
      const res = await fetch("/api/sync/crisp/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dateStart: rangeStart,
          dateEnd: rangeEnd,
          ...(effectiveBrandId ? { brandId: effectiveBrandId } : {}),
        }),
      });
      if (res.status === 409) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(data?.error ?? "A sync is already running");
        await refreshStatus();
        return;
      }
      if (res.status === 400) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(data?.error ?? "Invalid date range");
        return;
      }
      if (!res.ok) {
        toast.error("Failed to start range sync");
        return;
      }
      const data = (await res.json()) as {
        progress?: SyncProgress;
        queued?: boolean;
      };
      if (data.queued) {
        toast.info("Queued — will start after the current sync", {
          description: effectiveBrandName
            ? `Range — ${effectiveBrandName} · ${rangeStart} → ${rangeEnd}`
            : `Range — ${rangeStart} → ${rangeEnd}`,
        });
        await refreshStatus();
        return;
      }
      if (data.progress) setProgress(data.progress);
      runningRef.current = true;
      setRunning(true);
      toast.success("Range sync started", {
        description: effectiveBrandName
          ? `${effectiveBrandName} · ${rangeStart} → ${rangeEnd}`
          : `${rangeStart} → ${rangeEnd}`,
      });
    } catch {
      toast.error("Failed to start range sync");
    } finally {
      setStarting(null);
    }
  };

  const haltSync = async (action: "pause" | "stop") => {
    setHalting(action);
    try {
      const res = await fetch("/api/sync/crisp/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pause: action === "pause" }),
      });
      if (!res.ok) {
        toast.error(`Failed to request ${action}`);
        return;
      }
      toast.success(action === "pause" ? "Pause requested" : "Stop requested", {
        description:
          action === "pause"
            ? "The sync will halt after the current page — resume it any time."
            : "The sync will halt after the current page.",
      });
      await refreshStatus();
    } catch {
      toast.error(`Failed to request ${action}`);
    } finally {
      setHalting(null);
    }
  };

  const removeQueued = async (id: string) => {
    setRemovingQueueId(id);
    try {
      const res = await fetch("/api/sync/crisp/queue/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        toast.error("Failed to remove queued sync");
        return;
      }
      toast.success("Removed from queue");
      await refreshStatus();
    } catch {
      toast.error("Failed to remove queued sync");
    } finally {
      setRemovingQueueId(null);
    }
  };

  const startNextQueued = async () => {
    setStartingNext(true);
    try {
      const res = await fetch("/api/sync/crisp/queue/start-next", {
        method: "POST",
      });
      if (res.status === 409) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(data?.error ?? "Cannot start the next queued sync");
        await refreshStatus();
        return;
      }
      if (!res.ok) {
        toast.error("Failed to start the next queued sync");
        return;
      }
      runningRef.current = true;
      setRunning(true);
      toast.success("Started next queued sync");
      await refreshStatus();
    } catch {
      toast.error("Failed to start the next queued sync");
    } finally {
      setStartingNext(false);
    }
  };

  // Buttons that trigger a start request stay enabled while a sync is
  // running — the click enqueues instead of starting immediately (see
  // startSync/startRangeSync's `queued` handling). Only a request actually
  // in flight (`starting`) disables them, to prevent a double-submit.
  const busy = starting !== null;
  const halted = Boolean(progress?.cancelRequested);
  const queue = progress?.queue ?? [];
  const queueHeld = Boolean(progress?.held);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Crisp sync</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {last?.finishedAt ? (
              <>
                <span suppressHydrationWarning>
                  Last sync{" "}
                  {formatDistanceToNow(new Date(last.finishedAt), {
                    addSuffix: true,
                  })}
                </span>
                <Badge
                  variant="outline"
                  className="border-emerald-200 bg-emerald-50 text-emerald-700 capitalize dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400"
                >
                  {last.status}
                </Badge>
                <span className="text-muted-foreground">
                  {last.kind} · {numberFormat.format(last.conversationsSynced)}{" "}
                  conversations, {numberFormat.format(last.messagesSynced)}{" "}
                  messages
                </span>
              </>
            ) : (
              <span>No completed sync yet.</span>
            )}
            {latestHalted && !running && (
              <span className="text-amber-600 dark:text-amber-400">
                Interrupted at page {latestHaltedPage} — continue where it
                left off.
                {brands.length > 1
                  ? Object.values(resumePages).some((page) => page > 1) &&
                    ` Earlier runs reached: ${formatResumePagesSummary(resumePages, brands)}.`
                  : resumePage > (latestHaltedPage ?? 1) &&
                    ` Earlier runs reached page ${resumePage}.`}
              </span>
            )}
          </CardDescription>
          <CardAction className="flex flex-wrap items-center gap-2">
            {running && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => haltSync("pause")}
                  disabled={halted || halting !== null}
                  className="border-amber-200 text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:border-amber-500/30 dark:text-amber-400 dark:hover:bg-amber-500/10"
                >
                  {halting === "pause" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Pause className="size-3.5" />
                  )}
                  {halted && progress?.cancelReason === "paused"
                    ? "Pausing…"
                    : "Pause"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => haltSync("stop")}
                  disabled={halted || halting !== null}
                  className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
                >
                  {halting === "stop" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Square className="size-3.5" />
                  )}
                  {halted && progress?.cancelReason !== "paused"
                    ? "Stopping…"
                    : "Stop"}
                </Button>
              </>
            )}
            {/* The resume ("Continue from a halted run") flow only makes
                sense when nothing is running — while a sync is running, the
                Full/Incremental buttons below stay enabled and enqueue
                instead (see startSync's `queued` handling), same as the
                default (no-halted-history) case. */}
            {!running && latestHalted ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    startSync({ key: "full", mode: "full", label: "Full sync" })
                  }
                >
                  {starting === "full" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  Sync from start
                </Button>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={resumeFrom}
                  disabled={busy}
                  onChange={(e) => {
                    setResumeFrom(e.target.value);
                    setResumeDirty(true);
                  }}
                  onBlur={() =>
                    setResumeFrom(String(clampResumePage(resumeFrom)))
                  }
                  aria-label="Resume from page"
                  className="h-8 w-20 tabular-nums"
                />
                <HelpTip subject="continue from page">
                  Each brand automatically continues from its own furthest
                  synced page — Continue already does this for every brand
                  with no input needed. This number is an optional manual
                  override for{" "}
                  {selectedBrandId
                    ? (brands.find((b) => b.id === selectedBrandId)?.name ??
                      "the selected brand")
                    : "the first brand"}{" "}
                  only; every other brand still resumes from its own
                  progress.
                </HelpTip>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    // The manual override (startPage + startPageBrandId) is
                    // only sent when the user actually edited the input —
                    // otherwise Continue relies entirely on `resume: true`,
                    // which resumes every brand from its own furthest page
                    // server-side (see getResumePages). A prefilled value
                    // the user never touched is NOT an edit (resumeDirty).
                    const overrideBrandId =
                      brands.length > 0 ? targetBrandKey : undefined;
                    startSync({
                      key: "resume",
                      // A halted incremental resumes AS incremental — it
                      // self-checkpoints and stops at fresh data, so forcing
                      // a full walk here would silently turn a light catch-up
                      // into a whole-archive crawl (review recommendation).
                      mode:
                        latestHalted?.kind === "incremental"
                          ? "incremental"
                          : "full",
                      resume: true,
                      ...(resumeDirty
                        ? {
                            startPage: clampResumePage(resumeFrom),
                            startPageBrandId: overrideBrandId,
                          }
                        : {}),
                      label: "Continue",
                    });
                  }}
                >
                  {starting === "resume" ? (
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
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    startSync({
                      key: "incremental",
                      mode: "incremental",
                      label: "Incremental sync",
                    })
                  }
                >
                  {starting === "incremental" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Zap className="size-3.5" />
                  )}
                  Incremental sync
                </Button>
                <HelpTip>
                  Incremental sync only fetches conversations updated since
                  the last completed sync — fast, good for daily catch-up.
                  Full sync re-fetches everything from page 1; use it for the
                  first run or if you suspect conversations were missed.
                </HelpTip>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    startSync({ key: "full", mode: "full", label: "Full sync" })
                  }
                >
                  {starting === "full" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  Sync now
                </Button>
              </>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {running && progress && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-500/30 dark:bg-blue-500/5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500 opacity-75" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-blue-600" />
                </span>
                <p className="text-sm font-medium text-blue-700 dark:text-blue-400">
                  {progress.kind === "incremental"
                    ? "Incremental sync"
                    : progress.kind === "range"
                      ? "Range sync"
                      : "Full sync"}{" "}
                  in progress
                </p>
                {progress.kind === "range" && progress.range && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700 tabular-nums dark:bg-blue-500/15 dark:text-blue-300">
                    {isoToDay(progress.range.start)} →{" "}
                    {isoToDay(progress.range.end)}
                  </span>
                )}
                {progress.statusMessage && (
                  <p className="text-muted-foreground truncate text-xs">
                    {progress.statusMessage}
                  </p>
                )}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground text-xs">
                    Current page
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                    {progress.currentPage ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">
                    Conversations synced
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                    {numberFormat.format(progress.conversationsSynced)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">
                    Messages synced
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                    {numberFormat.format(progress.messagesSynced)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">
                    Failed sessions
                  </dt>
                  <dd
                    className={cn(
                      "mt-0.5 flex items-center gap-1 text-sm font-semibold tabular-nums",
                      progress.failedSessions.length > 0 &&
                        "text-amber-600 dark:text-amber-400"
                    )}
                  >
                    {progress.failedSessions.length > 0 && (
                      <TriangleAlert className="size-3.5" />
                    )}
                    {numberFormat.format(progress.failedSessions.length)}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {/* Queued syncs — requests that came in while another sync was
              running (see /api/sync/crisp/start's enqueue path). Shown
              whenever entries are waiting, whether or not one is currently
              running: after a Stop/Pause the queue is HELD (nothing running)
              but the entries are still here waiting on "Start next". */}
          {queue.length > 0 && (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center gap-1.5">
                <ListOrdered className="text-muted-foreground size-3.5" />
                <p className="text-sm font-medium">Queued ({queue.length})</p>
                <HelpTip subject="sync queue">
                  Up to 5 requests can queue behind the running sync, first
                  in, first out. The queue lives in server memory only — a
                  restart clears it, same as a running sync&apos;s progress.
                  When you Stop or Pause the running sync, the queue is held
                  (nothing auto-starts) until you click &quot;Start
                  next&quot; — or until you manually start any other sync,
                  which also clears the hold and lets the remaining entries
                  auto-drain after it. Remove entries you no longer want
                  before starting anything new.
                </HelpTip>
              </div>
              <ul className="space-y-1">
                {queue.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="text-muted-foreground truncate">
                      {formatQueueEntry(entry, brands)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground size-5 shrink-0"
                      disabled={removingQueueId === entry.id}
                      onClick={() => removeQueued(entry.id)}
                      aria-label={`Remove queued sync: ${formatQueueEntry(entry, brands)}`}
                    >
                      {removingQueueId === entry.id ? (
                        <LoaderCircle className="size-3 animate-spin" />
                      ) : (
                        <X className="size-3" />
                      )}
                    </Button>
                  </li>
                ))}
              </ul>
              {queueHeld && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                  <span>Queue held after Stop/Pause — nothing will auto-start.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={startingNext}
                    onClick={startNextQueued}
                    className="h-6 border-amber-300 px-2 text-amber-700 hover:bg-amber-100 dark:border-amber-500/40 dark:text-amber-400 dark:hover:bg-amber-500/20"
                  >
                    {startingNext ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <Play className="size-3" />
                    )}
                    Start next
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Verification line for the most recent range run — reports in-range
              counts by BOTH candidate bases so the owner can tell which
              timestamp Crisp's date filter actually matches (see coverage.ts
              COVERAGE_BASIS). Retained until the next sync starts. */}
          {!running && progress?.kind === "range" && progress.range && (
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <CalendarRange className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <span className="text-foreground font-medium">
                  Last range sync ({isoToDay(progress.range.start)} →{" "}
                  {isoToDay(progress.range.end)}):
                </span>{" "}
                {formatRangeVerification(progress)}
              </span>
            </p>
          )}

          {/* Sync by date range — refill a specific gap the heatmap surfaced. */}
          <div
            ref={rangeFormRef}
            className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
          >
            <div className="flex flex-col gap-1">
              <label
                htmlFor="range-from"
                className="text-muted-foreground text-xs"
              >
                From
              </label>
              <Input
                id="range-from"
                type="date"
                value={rangeStart}
                max={rangeEnd || undefined}
                disabled={busy}
                onChange={(e) => setRangeStart(e.target.value)}
                className="h-8 w-[9.5rem] tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="range-to"
                className="text-muted-foreground text-xs"
              >
                To
              </label>
              <Input
                id="range-to"
                type="date"
                value={rangeEnd}
                min={rangeStart || undefined}
                disabled={busy}
                onChange={(e) => setRangeEnd(e.target.value)}
                className="h-8 w-[9.5rem] tabular-nums"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !rangeStart || !rangeEnd}
              onClick={startRangeSync}
            >
              {starting === "range" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <CalendarRange className="size-3.5" />
              )}
              Sync range — {effectiveBrandName ?? "all brands"}
            </Button>
            <HelpTip subject="range sync">
              Syncs only conversations Crisp reports in this date window, guarded
              so a wrongly-ignored filter can&apos;t run away into a full
              backfill. Click a month on a brand&apos;s coverage grid to fill
              these in AND scope the sync to that brand — or pick a brand
              above to always scope it. The result reports how many fell in
              range by last-activity vs created date.
            </HelpTip>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="text-muted-foreground size-4" />
            Recent sync runs
          </CardTitle>
          <CardDescription>
            The most recent sync jobs, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SyncLogTable logs={logs} brands={brands} />
        </CardContent>
      </Card>
    </div>
  );
}
