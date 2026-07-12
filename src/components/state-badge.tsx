import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Single source of truth for conversation-state colors so every screen
 * (inbox list, detail header, visitor panel, RAG results) renders the same
 * state in the same color.
 */
const STATE_STYLES: Record<string, string> = {
  resolved:
    "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  unresolved:
    "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  pending:
    "border-transparent bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400",
};

/** Colored conversation-state badge (resolved / unresolved / pending). */
export function StateBadge({
  state,
  className,
}: {
  state: string | null;
  className?: string;
}) {
  if (!state) return null;
  return (
    <Badge
      className={cn(
        "capitalize",
        STATE_STYLES[state.toLowerCase()] ?? STATE_STYLES.pending,
        className
      )}
    >
      {state}
    </Badge>
  );
}

/**
 * Single source of truth for support-thread / suggestion statuses
 * (used on the global dashboard and the Suggestions page).
 */
const THREAD_STATUS_STYLES: Record<string, string> = {
  new: "border-transparent bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400",
  drafted:
    "border-transparent bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400",
  failed:
    "border-transparent bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  reviewed:
    "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  dismissed:
    "border-transparent bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400",
};

export function ThreadStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <Badge
      className={cn(
        "capitalize",
        THREAD_STATUS_STYLES[status] ?? THREAD_STATUS_STYLES.new,
        className
      )}
    >
      {status}
    </Badge>
  );
}

/**
 * Compact "New reply" badge for a support thread that a customer just bumped
 * with a fresh reply (SupportThread.hasNewReply). Sky-toned so it reads as
 * distinct from the status badge sitting next to it.
 */
export function NewReplyBadge({ className }: { className?: string }) {
  return (
    <Badge
      className={cn(
        "border-transparent bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400",
        className
      )}
    >
      New reply
    </Badge>
  );
}

/**
 * Amber "Follow-up due" badge: the support team promised an update N days ago
 * (SupportThread.followupPromisedAt) and nothing has been posted since. Shown
 * only once the promise is older than WPORG_PROMISE_REMINDER_DAYS (that gating
 * is computed server-side; this component just renders). Amber reads as
 * "overdue / needs attention", distinct from the sky "New reply" badge.
 */
export function FollowupDueBadge({
  days,
  className,
}: {
  days: number;
  className?: string;
}) {
  return (
    <Badge
      title={`Support promised a follow-up ${days} day${days === 1 ? "" : "s"} ago and nothing was posted since.`}
      className={cn(
        "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
        className
      )}
    >
      Follow-up due
    </Badge>
  );
}

/**
 * Muted "Waiting on customer" badge: the support team posted the last reply
 * with no follow-up promise, and the customer has been silent for less than
 * WPORG_SILENCE_NUDGE_DAYS (SupportThread.waitingSince). The ball is with the
 * customer but it's too soon to nudge a close, so this reads as neutral —
 * distinct from the amber "No response" badge that follows the threshold.
 */
export function WaitingOnCustomerBadge({ className }: { className?: string }) {
  return (
    <Badge
      title="Your team posted the latest reply — waiting on the customer to respond."
      className={cn(
        "border-transparent bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400",
        className
      )}
    >
      Waiting on customer
    </Badge>
  );
}

/**
 * Amber "No response · Nd" badge: a waiting topic whose customer silence has
 * passed WPORG_SILENCE_NUDGE_DAYS (that gating is computed server-side; this
 * component just renders). It reads as "probably closeable" — the topic shows
 * in the "Needs resolved" tab and its follow-up box offers a gentle-close draft.
 */
export function NoResponseBadge({
  days,
  className,
}: {
  days: number;
  className?: string;
}) {
  return (
    <Badge
      title={`No customer response for ${days} day${days === 1 ? "" : "s"} since your team's last reply — this topic can probably be closed.`}
      className={cn(
        "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
        className
      )}
    >
      No response · {days}d
    </Badge>
  );
}

/** Avatar-fallback initials derived from a nickname or email. */
export function initialsOf(
  nickname: string | null | undefined,
  email?: string | null
): string {
  const source = nickname?.trim() || email?.trim();
  if (!source) return "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}
