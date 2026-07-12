/**
 * Heuristic junk classifier for Crisp conversations. Pure and deterministic —
 * NO LLM calls, NO database access — so it can run cheaply inside the sync
 * loop and the backfill scan, and be unit-tested exhaustively.
 *
 * "Junk" here means automated noise that pollutes the conversations list and,
 * worse, gets chunked into the RAG index the AI learns from: no-reply
 * notification emails forwarded into Crisp (e.g. a wordpress.org
 * "[WordPress Plugin] Review pending" mail) that no operator ever answered.
 *
 * The classifier is deliberately CONSERVATIVE — every signal is an enumerated
 * rule with a stable, human-readable reason string, and anything that doesn't
 * match a rule is left alone. A real customer who happens to open with a
 * bracketed subject ("[URGENT] help!") and GETS answered must never be
 * flagged, so the notification-subject rule additionally requires that no
 * operator ever replied.
 */

export interface JunkClassifierInput {
  /** Visitor email as synced (Crisp meta.email), or null. */
  visitorEmail: string | null;
  /** The conversation's last-message preview (Crisp last_message), or null. */
  lastMessagePreview: string | null;
  /** How many operator messages the conversation has (0 = never answered). */
  operatorMessageCount: number;
  /** How many customer messages the conversation has. */
  userMessageCount: number;
}

export interface JunkClassification {
  junk: boolean;
  /** Stable reason wording when junk; null when not junk. */
  reason: string | null;
}

/**
 * A no-reply / automated sender address. Anchored so the tell-tale word must
 * sit at the START of the local part or right after a `.`, `_` or `-`
 * separator, immediately before the `@` — so `noreply@x.com`,
 * `bob.no-reply@x.com` and `mailer-daemon@host` match, while a real customer
 * like `alexnoreply@gmail.com` (the word buried mid-word, no separator before
 * it) does NOT.
 */
const AUTOMATED_SENDER = /(^|[._-])(no-?reply|donotreply|mailer-daemon|notifications?)@/i;

/** Any address on the wordpress.org domain (plugin-review / SVN notifications). */
const WORDPRESS_ORG_SENDER = /@wordpress\.org$/i;

/**
 * A bracketed notification subject prefix, e.g. "[WordPress Plugin] …",
 * "[Ticket #123] …". Bounded length (2–40 chars inside the brackets) so a
 * stray "[" doesn't run away. Tested against the last-message preview only
 * as one half of the notification rule — the operator-silence check below is
 * what makes it safe.
 */
const BRACKETED_SUBJECT = /^\s*\[[^\]]{2,40}\]/;

/**
 * Classify one conversation as junk (with a reason) or not. See the module
 * doc comment for the intent. Rules, in priority order:
 *
 * 1. No-reply / automated sender — the visitor email is a no-reply address or
 *    sits on the wordpress.org domain → junk ("automated sender").
 * 2. Automated notification subject — the last-message preview opens with a
 *    bracketed tag AND no operator ever replied (operatorMessageCount === 0)
 *    → junk ("bracketed notification subject, never answered"). The
 *    operator-silence condition is REQUIRED: an answered customer thread is
 *    never junk, however it opened.
 *
 * When both the sender and the subject rules would fire, the sender reason
 * wins (checked first).
 */
export function classifyJunk(input: JunkClassifierInput): JunkClassification {
  const email = input.visitorEmail?.trim() ?? "";
  if (email && (AUTOMATED_SENDER.test(email) || WORDPRESS_ORG_SENDER.test(email))) {
    return { junk: true, reason: "automated sender" };
  }

  const preview = input.lastMessagePreview ?? "";
  if (BRACKETED_SUBJECT.test(preview) && input.operatorMessageCount === 0) {
    return {
      junk: true,
      reason: "bracketed notification subject, never answered",
    };
  }

  return { junk: false, reason: null };
}
