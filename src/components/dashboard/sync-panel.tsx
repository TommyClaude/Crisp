"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  History,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Square,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import {
  SyncLogTable,
  type SerializedSyncLog,
} from "@/components/dashboard/sync-log-table";
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

/** Mirrors the shape returned by GET /api/sync/crisp/status → progress. */
interface SyncProgress {
  running: boolean;
  kind: "full" | "incremental" | "single" | null;
  currentPage: number | null;
  conversationsSynced: number;
  messagesSynced: number;
  failedSessions: string[];
  startedAt: string | null;
  lastSessionId: string | null;
  statusMessage: string | null;
  cancelRequested: boolean;
  cancelReason?: "cancelled" | "paused";
}

interface StatusResponse {
  progress: SyncProgress;
  lastCompleted: SerializedSyncLog | null;
  recentLogs: SerializedSyncLog[];
  resumePage: number;
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
  /** The furthest page any past sync run has reached (see getResumePage). */
  resumePage: number;
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
}: SyncPanelProps) {
  const router = useRouter();
  const [progress, setProgress] = React.useState<SyncProgress | null>(null);
  const [logs, setLogs] = React.useState<SerializedSyncLog[]>(recentLogs);
  const [last, setLast] = React.useState<LastSyncSummary | null>(lastSync);
  // The furthest page any past run has reached, across all sync history —
  // the default "Continue" resume point. Kept separate from the input value
  // below so a manual edit is never clobbered by a status refresh.
  const [resumePage, setResumePage] = React.useState(initialResumePage);
  // Kept as a string so the field can be freely edited (including a brief
  // empty state) without fighting the user on every keystroke; parsed and
  // clamped to an integer >= 1 on blur and again right before starting.
  const [resumeFrom, setResumeFrom] = React.useState(String(initialResumePage));
  const [starting, setStarting] = React.useState<
    "full" | "incremental" | "resume" | null
  >(null);
  const [halting, setHalting] = React.useState<"pause" | "stop" | null>(null);
  const [running, setRunning] = React.useState(false);
  const runningRef = React.useRef(false);

  // The input tracks the latest computed resume page until the user edits it.
  React.useEffect(() => {
    setResumeFrom(String(resumePage));
  }, [resumePage]);

  // The most recent run that isn't still running. When it didn't complete
  // (paused/cancelled/failed — a failed run included, so a bad token never
  // hides the continue affordance) offer to continue the backfill, using the
  // resume page derived from the FURTHEST page reached across all history,
  // not just this run's own page.
  const latestHalted = React.useMemo(() => {
    const latest = logs.find((log) => log.status !== "running");
    if (!latest || latest.status === "completed") return null;
    return latest;
  }, [logs]);
  // Where this specific run itself stopped (for the "Interrupted at" copy) —
  // may be behind resumePage if an earlier run got further.
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
        // A sync we were watching just finished — refresh server data.
        toast.info("Sync finished", {
          description: data.progress?.statusMessage ?? undefined,
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
    label: string;
  }) => {
    setStarting(opts.key);
    try {
      const res = await fetch("/api/sync/crisp/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: opts.mode, startPage: opts.startPage }),
      });
      if (res.status === 409) {
        toast.error("A sync is already running");
        await refreshStatus();
        return;
      }
      if (!res.ok) {
        toast.error("Failed to start sync");
        return;
      }
      const data = (await res.json()) as { progress?: SyncProgress };
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

  const busy = running || starting !== null;
  const halted = Boolean(progress?.cancelRequested);

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
                {resumePage > (latestHaltedPage ?? 1) &&
                  ` Earlier runs reached page ${resumePage}.`}
              </span>
            )}
          </CardDescription>
          <CardAction className="flex flex-wrap items-center gap-2">
            {running ? (
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
            ) : latestHalted ? (
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
                  onChange={(e) => setResumeFrom(e.target.value)}
                  onBlur={() =>
                    setResumeFrom(String(clampResumePage(resumeFrom)))
                  }
                  aria-label="Resume from page"
                  className="h-8 w-20 tabular-nums"
                />
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    startSync({
                      key: "resume",
                      mode:
                        latestHalted.kind === "incremental"
                          ? "incremental"
                          : "full",
                      startPage: clampResumePage(resumeFrom),
                      label: "Continue",
                    })
                  }
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
        {running && progress && (
          <CardContent>
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-500/30 dark:bg-blue-500/5">
              <div className="flex items-center gap-2">
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500 opacity-75" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-blue-600" />
                </span>
                <p className="text-sm font-medium text-blue-700 dark:text-blue-400">
                  {progress.kind === "incremental"
                    ? "Incremental sync"
                    : "Full sync"}{" "}
                  in progress
                </p>
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
          </CardContent>
        )}
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
          <SyncLogTable logs={logs} />
        </CardContent>
      </Card>
    </div>
  );
}
