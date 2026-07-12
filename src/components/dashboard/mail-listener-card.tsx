"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { LoaderCircle, Mail, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { HelpTip } from "@/components/help-tip";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * "Mail listener" health card — the dashboard's at-a-glance answer to "is the
 * wp.org email-push feature alive?" Polls GET /api/wporg/mail/status every
 * 15s (same cadence as the /suggestions status dot — see MAIL_POLL_INTERVAL_MS
 * in suggestions-manager.tsx) and offers a manual Restart.
 *
 * Client-only data: everything time-based renders from state set in
 * useEffect, so the server-rendered/first-paint markup never contains a
 * relative time — no hydration mismatch risk.
 */

/** Mirrors MailListenerStatus in src/lib/wporg/mail-listener.ts — kept as a
 *  local literal union (rather than importing the server module) since that
 *  file pulls in imapflow/prisma, which a client component must never bundle. */
type MailListenerStatus =
  | "disabled"
  | "connecting"
  | "listening"
  | "error"
  | "stopped";

/** Payload from GET /api/wporg/mail/status. */
interface MailListenerStatusResponse {
  status: MailListenerStatus;
  lastError: string | null;
  lastEventAt: string | null;
  eventsProcessed: number;
  connectedAt: string | null;
  cursor: {
    lastUid: number;
    uidValidity: string;
    updatedAt: string;
  } | null;
  /**
   * Draft count from a concurrently-shipping feature — optional so this card
   * renders correctly whether or not the field has landed yet.
   */
  drafted?: number;
}

const POLL_INTERVAL_MS = 15000;

const numberFormat = new Intl.NumberFormat("en-US");

const STATUS_META: Record<
  MailListenerStatus,
  { label: string; dot: string }
> = {
  listening: { label: "Listening", dot: "bg-emerald-500" },
  connecting: { label: "Connecting", dot: "bg-amber-500" },
  error: { label: "Error", dot: "bg-red-500" },
  disabled: { label: "Disabled", dot: "bg-muted-foreground/40" },
  stopped: { label: "Stopped", dot: "bg-muted-foreground/40" },
};

/** Relative time from an ISO string, or an em-dash when unset. */
function relativeOrDash(iso: string | null | undefined): string {
  if (!iso) return "—";
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

export function MailListenerCard() {
  const [status, setStatus] =
    React.useState<MailListenerStatusResponse | null>(null);
  const [restarting, setRestarting] = React.useState(false);
  // Consecutive failed polls — lets the card say "couldn't load" instead of
  // sitting on a skeleton (or silently going stale) through a real incident.
  const [failedPolls, setFailedPolls] = React.useState(0);
  // Monotonic request sequence: a response only applies while it is still the
  // NEWEST request issued. Guards both the setInterval+fetch out-of-order race
  // (a slow old response overwriting a fresher one) and setState after
  // unmount (cleanup bumps the sequence, orphaning in-flight responses).
  const seqRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const res = await fetch("/api/wporg/mail/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MailListenerStatusResponse;
      if (seq !== seqRef.current) return; // stale response or unmounted
      setStatus(data);
      setFailedPolls(0);
    } catch {
      if (seq !== seqRef.current) return;
      setFailedPolls((n) => n + 1); // next tick may succeed
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      seqRef.current += 1; // orphan any in-flight response
    };
  }, [refresh]);

  const restart = async () => {
    setRestarting(true);
    try {
      const res = await fetch("/api/wporg/mail/restart", { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        status?: MailListenerStatusResponse;
        restarted?: boolean;
      } | null;
      if (!res.ok) {
        toast.error(data?.error ?? "Failed to restart the mail listener");
        return;
      }
      toast.success("Mail listener restarted");
      await refresh();
    } catch {
      toast.error("Failed to restart the mail listener");
    } finally {
      setRestarting(false);
    }
  };

  const isError = status?.status === "error";
  const showRestart = status != null && status.status !== "disabled";

  return (
    <Card className={cn(isError && "border-red-200 dark:border-red-500/30")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="text-muted-foreground size-4" />
          Mail listener
        </CardTitle>
        <CardDescription>
          Near-realtime wp.org forum updates via a dedicated email inbox.
        </CardDescription>
        {showRestart && (
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              disabled={restarting}
              onClick={restart}
            >
              {restarting ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Restart
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!status ? (
          failedPolls >= 2 ? (
            <p className="text-muted-foreground text-sm">
              Couldn&apos;t load the mail-listener status — retrying
              automatically.
            </p>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          )
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm font-medium">
              <span
                className={cn(
                  "size-2.5 shrink-0 rounded-full",
                  STATUS_META[status.status].dot
                )}
                aria-hidden
              />
              {STATUS_META[status.status].label}
            </div>

            {status.status === "disabled" ? (
              <p className="text-muted-foreground text-sm">
                Set WPORG_MAIL_* in .env to enable near-realtime forum
                updates.
              </p>
            ) : (
              <>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Connected</dt>
                    <dd className="mt-0.5" suppressHydrationWarning>
                      {relativeOrDash(status.connectedAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground flex items-center gap-1">
                      Last mail activity
                      <HelpTip subject="last mail activity" side="top">
                        Ticks for every email the listener consumes — including
                        mail that gets filtered out because it isn&apos;t a
                        wp.org notification. That makes it the best signal
                        that the mailbox connection itself is still alive,
                        even during a quiet stretch of real notifications.
                      </HelpTip>
                    </dt>
                    <dd className="mt-0.5" suppressHydrationWarning>
                      {relativeOrDash(status.cursor?.updatedAt)}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">
                      Last wp.org notification
                    </dt>
                    <dd className="mt-0.5" suppressHydrationWarning>
                      {relativeOrDash(status.lastEventAt)} ·{" "}
                      {numberFormat.format(status.eventsProcessed)} processed
                      {typeof status.drafted === "number"
                        ? ` · ${numberFormat.format(status.drafted)} drafted`
                        : ""}
                    </dd>
                  </div>
                </dl>

                {status.lastError &&
                (isError || status.status === "connecting") ? (
                  // Shown while connecting too: during a reconnect loop the
                  // status flips error→connecting, and hiding the reason for
                  // half of every cycle made a stuck loop look mysterious.
                  <p
                    className="truncate rounded-md border border-red-200 bg-red-50 px-2 py-1.5 font-mono text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400"
                    title={status.lastError}
                  >
                    {status.lastError}
                  </p>
                ) : null}
              </>
            )}
            {failedPolls >= 2 ? (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                Status refresh failing — showing the last known state.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
