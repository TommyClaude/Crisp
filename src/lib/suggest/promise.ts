import {
  availableProviders,
  generateDraftFor,
  MAX_CLASSIFY_TOKENS,
} from "./llm";

/**
 * Follow-up promise detection + date-gating.
 *
 * When the support team posts the last reply in a wp.org thread, it often
 * promises a further update ("let me check with our team and get back to you")
 * and then forgets. The watcher's resurface path calls
 * {@link classifyFollowupPromise} on that last post to decide whether to arm a
 * reminder (SupportThread.followupPromisedAt); the pure {@link isPromiseDue}
 * gate then decides when that armed promise has gone overdue.
 */

/** Milliseconds in a day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Max characters of the support post fed to the tiny classifier call. */
const CLASSIFY_POST_CHARS = 1000;

/**
 * The classifier system prompt. Deliberately narrow: it asks ONLY whether the
 * support team's own last message promises more to come, and forces a
 * one-word answer so the reply is cheap and trivially parseable.
 */
export const PROMISE_CLASSIFIER_SYSTEM =
  "You triage support forum threads. The support team wrote the latest reply, " +
  'quoted below. Does it promise a further update, investigation, or answer ' +
  'from the team (e.g. "let me check and get back to you")? Reply with exactly ' +
  "YES or NO.";

/**
 * Parse the classifier's raw text into a boolean. Only a clear leading "YES"
 * counts as a promise; everything else (a "NO", a hedge, an empty string, an
 * explanation that doesn't open with YES) is treated as NO. Exported for unit
 * testing the parse rule in isolation.
 */
export function parsePromiseAnswer(text: string): boolean {
  return /^\s*yes\b/i.test(text);
}

/**
 * Classify whether the support team's last post promised a follow-up, using
 * the first available LLM provider with a tiny token cap. Best-effort by
 * design: no provider, an empty answer, or any error all resolve to `false`
 * (log, never throw) so a classification hiccup can never fail a forum check.
 */
export async function classifyFollowupPromise(
  postText: string
): Promise<boolean> {
  const provider = availableProviders()[0];
  if (!provider) return false;
  try {
    const { text } = await generateDraftFor(
      provider,
      PROMISE_CLASSIFIER_SYSTEM,
      postText.slice(0, CLASSIFY_POST_CHARS),
      MAX_CLASSIFY_TOKENS
    );
    return parsePromiseAnswer(text);
  } catch (error) {
    console.error("Follow-up promise classification failed:", error);
    return false;
  }
}

/**
 * The instant at/before which an armed promise is considered overdue: `now`
 * minus the grace period. A row whose followupPromisedAt is `<=` this is due.
 */
export function promiseDueCutoff(reminderDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - reminderDays * MS_PER_DAY);
}

/**
 * Pure date gate for the "Follow-up due" badge and the "Needs reply" queue: a
 * promise is due only when it is set AND older than the grace period (right
 * after the promise, nothing is due yet). Kept side-effect-free for unit tests.
 */
export function isPromiseDue(
  promisedAt: Date | null | undefined,
  reminderDays: number,
  now: Date = new Date()
): boolean {
  if (!promisedAt) return false;
  return promisedAt.getTime() <= promiseDueCutoff(reminderDays, now).getTime();
}

/** Whole days elapsed since `promisedAt` — the N in the badge tooltip. */
export function daysSincePromise(promisedAt: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - promisedAt.getTime()) / MS_PER_DAY);
}

/**
 * Customer-silence date-gating for the "Needs resolved" tab. When the support
 * team posts the last reply WITHOUT promising more (see the watcher's resurface
 * path), the topic starts waiting on the customer (SupportThread.waitingSince).
 * These pure gates mirror the promise ones above: {@link silenceNudgeCutoff}
 * is the instant a waiting clock must predate to count as "silent long enough",
 * {@link isSilenceNudgeDue} applies it to a nullable column, and
 * {@link daysSinceWaiting} is the N in the "No response · Nd" badge.
 */

/** The instant at/before which a waiting topic's silence is long enough to
 *  surface in "Needs resolved": `now` minus the nudge period. */
export function silenceNudgeCutoff(
  nudgeDays: number,
  now: Date = new Date()
): Date {
  return new Date(now.getTime() - nudgeDays * MS_PER_DAY);
}

/**
 * Pure date gate for the "Needs resolved" tab and the "No response" badge: a
 * topic counts as silent only when waitingSince is set AND older than the nudge
 * period (right after the team's reply, nothing is due yet). Side-effect-free.
 */
export function isSilenceNudgeDue(
  waitingSince: Date | null | undefined,
  nudgeDays: number,
  now: Date = new Date()
): boolean {
  if (!waitingSince) return false;
  return waitingSince.getTime() <= silenceNudgeCutoff(nudgeDays, now).getTime();
}

/** Whole days elapsed since the waiting clock started — the N in the badge. */
export function daysSinceWaiting(waitingSince: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - waitingSince.getTime()) / MS_PER_DAY);
}

/** Minimal row shape the Needs-reply ordering needs. */
export interface NeedsReplySortRow {
  hasNewReply: boolean;
  followupPromisedAt: Date | null;
  lastActivityAt: Date | null;
  fetchedAt: Date;
}

/**
 * Flagged-first ordering for the "Needs reply" queue: topics flagged for
 * attention (a fresh customer reply OR an overdue promise) float to the top,
 * then lastActivityAt desc (nulls last) with a fetchedAt desc tiebreak.
 * Promise-due isn't a plain column, so this JS pass refines the coarse DB
 * order. Pure (sorts a copy) and lives here — not in the client-imported
 * suggestions-view — because it depends on {@link isPromiseDue}.
 */
export function sortNeedsReplyRows<T extends NeedsReplySortRow>(
  rows: T[],
  reminderDays: number,
  now: Date = new Date()
): T[] {
  const flagged = (row: NeedsReplySortRow) =>
    row.hasNewReply || isPromiseDue(row.followupPromisedAt, reminderDays, now);
  return [...rows].sort((a, b) => {
    const fa = flagged(a) ? 0 : 1;
    const fb = flagged(b) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const la = a.lastActivityAt ? a.lastActivityAt.getTime() : -Infinity;
    const lb = b.lastActivityAt ? b.lastActivityAt.getTime() : -Infinity;
    if (la !== lb) return lb - la;
    return b.fetchedAt.getTime() - a.fetchedAt.getTime();
  });
}
