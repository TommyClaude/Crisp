"use client";

import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** A SyncLog row with Date fields serialized to ISO strings. */
export interface SerializedSyncLog {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  conversationsSynced: number;
  messagesSynced: number;
  failedSessions: string[];
  error: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  completed:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400",
  failed:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400",
  running:
    "animate-pulse border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400",
  cancelled:
    "border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("capitalize", STATUS_STYLES[status])}
    >
      {status}
    </Badge>
  );
}

function formatStarted(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : format(date, "MMM d, HH:mm");
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatPages(pageFrom: number | null, pageTo: number | null): string {
  if (pageFrom == null && pageTo == null) return "—";
  return `${pageFrom ?? "?"} → ${pageTo ?? "?"}`;
}

const numberFormat = new Intl.NumberFormat("en-US");

export function SyncLogTable({ logs }: { logs: SerializedSyncLog[] }) {
  if (logs.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        No sync runs yet. Start a sync to populate the archive.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Kind</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Pages</TableHead>
          <TableHead className="text-right">Conversations</TableHead>
          <TableHead className="text-right">Messages</TableHead>
          <TableHead>Error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.map((log) => (
          <TableRow key={log.id}>
            <TableCell className="font-medium capitalize">{log.kind}</TableCell>
            <TableCell>
              <StatusBadge status={log.status} />
            </TableCell>
            {/* Local-timezone formatting differs between server and browser;
                suppress the expected hydration diff on this cell. */}
            <TableCell
              className="text-muted-foreground tabular-nums"
              suppressHydrationWarning
            >
              {formatStarted(log.startedAt)}
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {formatDuration(log.startedAt, log.finishedAt)}
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {formatPages(log.pageFrom, log.pageTo)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {numberFormat.format(log.conversationsSynced)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {numberFormat.format(log.messagesSynced)}
            </TableCell>
            <TableCell>
              {log.error ? (
                <span
                  title={log.error}
                  className="text-destructive block max-w-56 truncate"
                >
                  {log.error}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
