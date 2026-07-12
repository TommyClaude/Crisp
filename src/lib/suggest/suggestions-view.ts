import type { Prisma } from "@prisma/client";

/**
 * Shared, pure view-model for the /suggestions tabs: which tab is which, how
 * the default "Needs reply" work queue is filtered, and which empty-state
 * message a given tab shows. Kept free of React and Prisma runtime imports
 * (type-only) so both the server page and the client manager import it, and so
 * the branchy logic is unit-testable without a browser or a request.
 */

/** URL `?status=` value for the default work-queue tab. */
export const NEEDS_REPLY = "needs-reply";
/** URL `?status=` value for the "can probably be closed" tab (silent topics). */
export const NEEDS_RESOLVED = "needs-resolved";
/** URL `?status=` value for the browse-all tab (no status filter). */
export const RECENT = "recent";
/** The tab shown when `?status=` is absent. */
export const DEFAULT_TAB = NEEDS_REPLY;

/** Real SupportThread.status values a status tab filters on directly. */
export const REAL_STATUSES = new Set([
  "new",
  "drafted",
  "failed",
  "reviewed",
  "dismissed",
]);

export interface SuggestionTab {
  /** URL `?status=` value (NEEDS_REPLY / RECENT / a real status). */
  value: string;
  label: string;
}

/**
 * Tabs in display order. "No draft" keeps the legacy `new` URL value for
 * bookmark/compat even though its label no longer says "New"; the old
 * standalone "Drafted" tab is intentionally gone (drafted topics live in the
 * Needs-reply queue and in Recent).
 */
export const SUGGESTION_TABS: SuggestionTab[] = [
  { value: NEEDS_REPLY, label: "Needs reply" },
  { value: NEEDS_RESOLVED, label: "Needs resolved" },
  { value: RECENT, label: "Recent" },
  { value: "new", label: "No draft" },
  { value: "failed", label: "Failed" },
  { value: "reviewed", label: "Reviewed" },
  { value: "dismissed", label: "Dismissed" },
];

/** The onboarding hint — correct ONLY when the whole DB has zero topics. */
export const ONBOARDING_EMPTY =
  'No forum topics yet — set a wp.org slug on your plugins, then click "Check forums now".';

/** How a raw `?status=` param maps onto the query shapes. */
export type ResolvedTab =
  | { kind: "needs-reply" }
  | { kind: "needs-resolved" }
  | { kind: "recent" }
  | { kind: "status"; status: string };

/**
 * Interpret the `?status=` param. Absent, NEEDS_REPLY, or anything unknown all
 * resolve to the default Needs-reply queue; NEEDS_RESOLVED is the silent-topics
 * tab; RECENT is browse-all; a known real status is a plain status filter.
 */
export function resolveTab(statusParam: string | undefined | null): ResolvedTab {
  if (statusParam === NEEDS_RESOLVED) return { kind: "needs-resolved" };
  if (statusParam === RECENT) return { kind: "recent" };
  if (statusParam && REAL_STATUSES.has(statusParam)) {
    return { kind: "status", status: statusParam };
  }
  return { kind: "needs-reply" };
}

/** The active tab's `?status=` value for highlighting (never undefined). */
export function activeTabValue(statusParam: string | undefined | null): string {
  const resolved = resolveTab(statusParam);
  if (resolved.kind === "needs-reply") return NEEDS_REPLY;
  if (resolved.kind === "needs-resolved") return NEEDS_RESOLVED;
  if (resolved.kind === "recent") return RECENT;
  return resolved.status;
}

/**
 * The "Needs reply" work-queue filter: everything not yet handled by a human
 * (status new / drafted / failed) PLUS anything flagged for attention even if
 * already reviewed — a fresh customer reply (hasNewReply) or an overdue support
 * promise (followupPromisedAt at/older than the cutoff). Dismissed topics are
 * excluded unconditionally (a human deliberately discarded them), and reviewed
 * topics with no flag drop out. Topics waiting on the customer (the support
 * team replied last with no promise → waitingSince set) leave the plain backlog
 * — they belong in "Needs resolved", not this queue. `promiseCutoff` is
 * `now - grace period`.
 */
export function needsReplyWhere(
  promiseCutoff: Date
): Prisma.SupportThreadWhereInput {
  return {
    AND: [
      { status: { not: "dismissed" } },
      {
        OR: [
          // Backlog: unhandled AND not waiting on the customer.
          {
            AND: [
              { status: { in: ["new", "drafted", "failed"] } },
              { waitingSince: null },
            ],
          },
          { hasNewReply: true },
          // `<= cutoff` on a nullable column excludes NULLs in SQL, so an
          // unarmed promise never matches.
          { followupPromisedAt: { lte: promiseCutoff } },
        ],
      },
    ],
  };
}

/**
 * The queue split into two DISJOINT halves so the page cap can never drop a
 * flagged row: their union must stay exactly {@link needsReplyWhere}. Flagged
 * rows (fresh customer reply or overdue promise) are fetched separately from
 * the plain unhandled backlog and rendered first — a promise-due topic with an
 * old lastActivityAt must survive any number of fresher backlog rows.
 */
export function needsReplyFlaggedWhere(
  promiseCutoff: Date
): Prisma.SupportThreadWhereInput {
  return {
    AND: [
      { status: { not: "dismissed" } },
      {
        OR: [
          { hasNewReply: true },
          { followupPromisedAt: { lte: promiseCutoff } },
        ],
      },
    ],
  };
}

/** The unflagged remainder of the Needs-reply queue (see needsReplyFlaggedWhere). */
export function needsReplyBacklogWhere(
  promiseCutoff: Date
): Prisma.SupportThreadWhereInput {
  return {
    AND: [
      { status: { in: ["new", "drafted", "failed"] } },
      { hasNewReply: false },
      // Waiting on the customer (support replied last, no promise) — the topic
      // leaves the work queue for "Needs resolved" / Recent. `null` here keeps
      // this half disjoint from the flagged half and from "Needs resolved".
      { waitingSince: null },
      {
        OR: [
          { followupPromisedAt: null },
          { followupPromisedAt: { gt: promiseCutoff } },
        ],
      },
    ],
  };
}

/**
 * The "Needs resolved" tab: topics waiting on the customer whose silence has
 * passed the nudge threshold — the support team replied last with no follow-up
 * promise (waitingSince set), and the customer hasn't responded for
 * WPORG_SILENCE_NUDGE_DAYS. These can probably be closed. `silenceCutoff` is
 * `now - nudge period`; `<= cutoff` on the nullable waitingSince column excludes
 * NULLs in SQL, so a non-waiting or still-recent topic never matches. Dismissed
 * topics are excluded (a human already discarded them), and so are topics
 * already marked resolved on wordpress.org (wpResolved) — no point asking
 * permission to close a matter the forum already considers closed.
 */
export function needsResolvedWhere(
  silenceCutoff: Date
): Prisma.SupportThreadWhereInput {
  return {
    AND: [
      { status: { not: "dismissed" } },
      { wpResolved: false },
      { waitingSince: { lte: silenceCutoff } },
    ],
  };
}

/**
 * Pick the empty-state copy for a tab that returned zero rows. The onboarding
 * hint is correct ONLY when the entire DB is empty; a plugin filter narrowing
 * a non-empty DB to nothing gets the generic "no match"; otherwise each tab
 * gets its own honest line.
 */
export function emptyStateMessage(params: {
  tab: string;
  totalInDb: number;
  pluginFilterActive: boolean;
}): string {
  const { tab, totalInDb, pluginFilterActive } = params;
  if (totalInDb === 0) return ONBOARDING_EMPTY;
  if (pluginFilterActive) return "No topics match this filter.";
  switch (tab) {
    case NEEDS_REPLY:
      return "All caught up — nothing is waiting on your team.";
    case NEEDS_RESOLVED:
      return "No silent topics — every conversation is still active or closed.";
    case "new":
      return "Every topic has a draft.";
    case "failed":
      return "No failed drafts.";
    case "reviewed":
      return "Nothing marked reviewed yet.";
    case "dismissed":
      return "No dismissed topics.";
    default:
      return "No topics match this filter.";
  }
}
