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
