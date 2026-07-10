"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  History,
  LoaderCircle,
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
}

interface StatusResponse {
  progress: SyncProgress;
  lastCompleted: SerializedSyncLog | null;
  recentLogs: SerializedSyncLog[];
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
}

const numberFormat = new Intl.NumberFormat("en-US");

const POLL_INTERVAL_MS = 2000;

export function SyncPanel({ lastSync, recentLogs }: SyncPanelProps) {
  const router = useRouter();
  const [progress, setProgress] = React.useState<SyncProgress | null>(null);
  const [logs, setLogs] = React.useState<SerializedSyncLog[]>(recentLogs);
  const [last, setLast] = React.useState<LastSyncSummary | null>(lastSync);
  const [starting, setStarting] = React.useState<"full" | "incremental" | null>(
    null
  );
  const [stopping, setStopping] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const runningRef = React.useRef(false);

  const refreshStatus = React.useCallback(async () => {
    try {
      const res = await fetch("/api/sync/crisp/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as StatusResponse;
      setProgress(data.progress);
      if (Array.isArray(data.recentLogs)) setLogs(data.recentLogs);
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

  const startSync = async (mode: "full" | "incremental") => {
    setStarting(mode);
    try {
      const res = await fetch("/api/sync/crisp/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
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
      toast.success(
        mode === "full" ? "Full sync started" : "Incremental sync started"
      );
    } catch {
      toast.error("Failed to start sync");
    } finally {
      setStarting(null);
    }
  };

  const stopSync = async () => {
    setStopping(true);
    try {
      const res = await fetch("/api/sync/crisp/stop", { method: "POST" });
      if (!res.ok) {
        toast.error("Failed to request stop");
        return;
      }
      toast.success("Stop requested", {
        description: "The sync will halt after the current page.",
      });
      await refreshStatus();
    } catch {
      toast.error("Failed to request stop");
    } finally {
      setStopping(false);
    }
  };

  const busy = running || starting !== null;

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
          </CardDescription>
          <CardAction className="flex flex-wrap items-center gap-2">
            {running && (
              <Button
                variant="outline"
                size="sm"
                onClick={stopSync}
                disabled={stopping || Boolean(progress?.cancelRequested)}
                className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
              >
                <Square className="size-3.5" />
                {progress?.cancelRequested ? "Stopping…" : "Stop"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => startSync("incremental")}
              disabled={busy}
            >
              {starting === "incremental" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Zap className="size-3.5" />
              )}
              Incremental sync
            </Button>
            <Button size="sm" onClick={() => startSync("full")} disabled={busy}>
              {starting === "full" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw
                  className={cn("size-3.5", running && "animate-spin")}
                />
              )}
              Sync now
            </Button>
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
