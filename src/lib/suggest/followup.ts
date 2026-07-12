import { prisma } from "@/lib/db";
import { getEnv } from "@/env";
import {
  fetchTopicThread,
  type ForumPost,
} from "@/lib/wporg/forum-crawler";
import { availableProviders } from "./llm";
import { isSilenceNudgeDue } from "./promise";
import {
  appendReplyStyle,
  draftFromProviders,
  formatContextBlock,
  HUMAN_VOICE_RULE,
  retrieveContext,
  toContextSummary,
  voiceMimicryRule,
  type ContextChunkSummary,
  type DraftItem,
} from "./suggester";

/**
 * Follow-up reply drafter. Where the normal suggester answers a topic's FIRST
 * post, this drafts the NEXT reply the support team should post given the WHOLE
 * live wp.org thread. It fetches the topic page at generate time (replies are
 * not stored) and is triggered ONLY by the manual "Regenerate" action — the
 * watcher and bulk paths keep the cheaper 2-call first-reply behavior.
 */

/** Max characters of each transcript post fed into the follow-up prompt. */
const PROMPT_POST_CHARS = 1200;

/** Persisted shape of SupportThread.followupJson. Regenerate overwrites it. */
export interface FollowupResult {
  generatedAt: string;
  /** Total posts fetched from the live thread (lead post + replies). */
  postCount: number;
  drafts: DraftItem[];
  context: ContextChunkSummary[];
  /** Set when no drafts were produced: why the follow-up was skipped. */
  skipped?: "no_replies" | "fetch_failed" | "support_last";
  /**
   * Set (never together with `skipped`) when the drafts are a gentle CLOSING
   * reply — the support team posted last and the customer has been silent past
   * WPORG_SILENCE_NUDGE_DAYS. Lets the UI label the box "Closing reply" instead
   * of the normal follow-up header.
   */
  mode?: "gentle_close";
}

/**
 * What {@link draftFollowup} returns: the persistable {@link FollowupResult}
 * plus the live topic's wp.org resolution flag (`wpResolved`) read off the same
 * fetch — kept OUT of followupJson so the caller can write it to the dedicated
 * SupportThread.wpResolved column. null when no page was fetched (fetch_failed).
 */
export type DraftFollowupOutput = FollowupResult & {
  wpResolved: boolean | null;
};

export interface DraftFollowupInput {
  url: string;
  title: string;
  plugin: { id: string; name: string };
  /** The owning brand's house-style instructions, when set. */
  replyStyle?: string | null;
  /**
   * Deliver on a support-team promise: when true, a thread whose SUPPORT team
   * posted last is NOT skipped — instead the draft delivers the update the team
   * promised. Set from a standing followupPromisedAt or the manual "Draft
   * anyway" (forceFollowup) action.
   */
  deliverPromise?: boolean;
  /**
   * Draft a gentle CLOSING reply instead of skipping when the SUPPORT team
   * posted last and the customer has been silent past WPORG_SILENCE_NUDGE_DAYS.
   * Computed by the caller from the thread's waitingSince. Ignored when
   * `deliverPromise` is set (a promised update takes precedence over a close).
   */
  gentleClose?: boolean;
}

/**
 * Injected into the follow-up prompt when delivering on a promise, so the model
 * writes the team's overdue update instead of skipping (support posted last) or
 * closing the thread out. The exact wording is asserted in tests.
 */
export const PROMISE_DELIVERY_INSTRUCTION =
  "The support team's latest message promised to investigate and come back. " +
  "Draft the reply that DELIVERS on that promise: report the outcome or current " +
  "status and the next step. Do not treat the thread as closed.";

/**
 * Injected into the follow-up prompt for a gentle close: the support team
 * posted last and the customer has gone quiet, so the model writes a warm
 * permission-to-close reply instead of skipping or troubleshooting further.
 * The exact wording is asserted in tests.
 */
export const GENTLE_CLOSE_INSTRUCTION =
  "The support team posted the most recent reply and the customer has not " +
  "responded for several days. Draft a warm, brief closing reply: thank them, " +
  "note that you have not heard back, say you hope the issue is now resolved, " +
  "ask permission to close the topic, and invite them to reopen it or start a " +
  "new one anytime if they still need help. Do not repeat earlier " +
  "troubleshooting steps, do not add new ones, and do not share download links.";

/** A post counts as the support side when wp.org tagged it with a role. */
function isSupportPost(post: ForumPost): boolean {
  return post.role != null;
}

/**
 * Retrieval query for the follow-up: the topic title plus the NEWEST customer
 * message (the reply the follow-up must actually address), not the first post
 * — so the RAG context matches where the conversation has moved to. Exported
 * for unit testing the query construction in isolation.
 */
export function buildFollowupQuery(title: string, posts: ForumPost[]): string {
  const customerPosts = posts.filter((post) => !isSupportPost(post));
  const latest = customerPosts[customerPosts.length - 1] ?? posts[posts.length - 1];
  return `${title}\n${latest.text.slice(0, 400)}`.trim();
}

/** Render the thread as a role-labelled transcript (oldest first). */
function buildTranscript(posts: ForumPost[]): string {
  return posts
    .map((post, index) => {
      const who = isSupportPost(post)
        ? `SUPPORT${post.role ? ` (${post.role})` : ""}`
        : `CUSTOMER (${post.author})`;
      return `[${index + 1}] ${who}:\n${post.text.slice(0, PROMPT_POST_CHARS)}`;
    })
    .join("\n\n");
}

/**
 * Build the follow-up prompt — same grounding/tone as the first-reply prompt,
 * next-reply framing. Exported for unit testing the prompt construction (that
 * it carries the role-labelled transcript) without hitting the LLM.
 */
export function buildFollowupPrompt(
  title: string,
  posts: ForumPost[],
  pluginName: string,
  contextText: string,
  replyStyle?: string | null,
  deliverPromise: boolean = false,
  gentleClose: boolean = false
): { system: string; user: string } {
  // When delivering on a promise (or closing out a silent thread), lead with
  // the override so it frames the whole reply before the state-assessment rules
  // (whose "did the customer close it?" logic doesn't apply — SUPPORT posted
  // last in both cases). The two are mutually exclusive (a promise wins).
  const promiseFraming = deliverPromise ? `${PROMISE_DELIVERY_INSTRUCTION} ` : "";
  const gentleCloseFraming =
    !deliverPromise && gentleClose ? `${GENTLE_CLOSE_INSTRUCTION} ` : "";
  const system = appendReplyStyle(
    `You are a senior support engineer for the WordPress plugin "${pluginName}". ` +
      "You are drafting the NEXT reply your support team should post in an ongoing wordpress.org forum thread, for a human teammate to review and post. " +
      promiseFraming +
      gentleCloseFraming +
      // State assessment first: a thread that is already resolved must get a
      // short goodbye, not another round of troubleshooting — the retrieved
      // context is full of solutions and would otherwise drag the reply there.
      "FIRST assess the state of the conversation. If the customer's most recent message says the problem is solved, only thanks the team, or mentions having left a review, with no open question, reply with a SHORT, warm closing (1-3 sentences: thank them, say you're glad it's resolved, invite them to open a new topic if anything else comes up). In that case do NOT repeat earlier solutions, do NOT add troubleshooting steps, do NOT share download links, and ignore the provided context entirely. " +
      // Mixed state: a message that closes the old issue AND opens a new one
      // must not be swallowed as a pure goodbye, nor drag the solved issue
      // back up — thank briefly, then answer the new question from context.
      "If the customer's most recent message does BOTH (it closes the old issue with thanks, a resolved note, or a review, AND asks a new question or reports a new problem), then briefly acknowledge and thank them in ONE sentence, and then answer the new question grounded in the provided context. Do not treat this as a pure closing, and do not re-explain or re-litigate the already-solved issue. " +
      "Only when the customer's most recent message still contains an open problem or question: ground your answer ONLY in the provided context (past resolved support conversations, answered forum threads, and official documentation). " +
      "If the context does not contain a clear answer, say so and draft clarifying questions to ask the user instead of guessing. " +
      "Never invent features, settings, or file paths. Be friendly, concise and concrete: give numbered steps when applicable, " +
      "and reference documentation links from the context when they support the answer. " +
      "Continue the conversation naturally: stay consistent with what the support team has already said, do NOT repeat greetings or answers given earlier in the thread, and directly address the customer's most recent message. " +
      voiceMimicryRule(true) +
      " " +
      HUMAN_VOICE_RULE +
      " " +
      "Write plain text suitable for a forum reply (no markdown headings). Do not mention the context, Crisp, or that you are an AI. " +
      "Your state assessment is INTERNAL: never state it in the output. Output ONLY the reply text itself, with no analysis, no preamble, and no explanation of your decision. " +
      "When it reads naturally, open by addressing the person you are replying to by their @username.",
    replyStyle
  );

  const closing = deliverPromise
    ? "The support team already promised to follow up and now needs to deliver. Output ONLY the support team's next reply, delivering on that promise (the outcome or current status and the next step) — do not close the thread out."
    : gentleClose
      ? "The customer has gone quiet after the support team's last reply. Output ONLY the support team's next reply: a short, friendly message that thanks them, notes you have not heard back, hopes the issue is resolved, asks to close the topic, and invites them to reopen it or post again anytime. Do not troubleshoot further or reopen the solved issue."
      : "First decide silently (do not write this out) whether the customer's most recent message is closing the conversation (resolved / thanks / review left), still needs help, or does both at once (a thank-you plus a brand-new question), then output ONLY the support team's next reply.";

  const user =
    `Ongoing forum thread on wordpress.org/support/plugin:\n\n` +
    `Title: ${title}\n\n` +
    `Conversation so far (oldest first):\n\n${buildTranscript(posts)}\n\n` +
    `Context from past support conversations and documentation:\n\n${contextText || "(no relevant context found)"}\n\n` +
    closing;

  return { system, user };
}

/**
 * Pure follow-up drafting core: fetch the live thread, and — when it has at
 * least one reply beyond the opening post — retrieve context keyed on the
 * newest message and draft from every provider. Never throws for an
 * unreachable thread: returns a `skipped` result the caller persists as-is.
 */
export async function draftFollowup(
  input: DraftFollowupInput
): Promise<DraftFollowupOutput> {
  const generatedAt = new Date().toISOString();

  const fetched = await fetchTopicThread(input.url);
  if (!fetched) {
    // No page fetched — leave wpResolved unknown (null) so the caller doesn't
    // overwrite the stored flag on a transient failure.
    return {
      generatedAt,
      postCount: 0,
      drafts: [],
      context: [],
      skipped: "fetch_failed",
      wpResolved: null,
    };
  }

  // Opening post + at least one reply required — a follow-up only makes sense
  // once the customer (or someone) has said something after the question.
  if (fetched.posts.length < 2) {
    return {
      generatedAt,
      postCount: fetched.posts.length,
      drafts: [],
      context: [],
      skipped: "no_replies",
      wpResolved: fetched.resolved,
    };
  }

  // The support team spoke last — normally the ball is with the customer, so
  // there is nothing to reply to yet and we skip (no wasted LLM calls). Two
  // exceptions keep drafting instead of skipping:
  //   - deliverPromise (a standing followupPromisedAt, or manual "Draft
  //     anyway"): the team owes an update, drafted with the promise framing.
  //   - gentleClose (the customer has been silent past WPORG_SILENCE_NUDGE_DAYS,
  //     computed by the caller from waitingSince): draft a polite closing reply.
  // A promise wins over a close when both are somehow set.
  const supportLast = isSupportPost(fetched.posts[fetched.posts.length - 1]);
  // A topic already marked resolved on wp.org needs no permission-to-close
  // reply — keep the plain support_last skip note instead (the wpResolved
  // refresh from this same fetch also drops it from the "Needs resolved" tab).
  const gentleClose =
    supportLast &&
    !input.deliverPromise &&
    (input.gentleClose ?? false) &&
    !fetched.resolved;

  if (!input.deliverPromise && !gentleClose && supportLast) {
    return {
      generatedAt,
      postCount: fetched.posts.length,
      drafts: [],
      context: [],
      skipped: "support_last",
      wpResolved: fetched.resolved,
    };
  }

  const title = fetched.title ?? input.title;
  const query = buildFollowupQuery(title, fetched.posts);
  const context = await retrieveContext(query, input.plugin.id);
  const contextChunks = context.map(toContextSummary);

  const drafts =
    availableProviders().length > 0
      ? await draftFromProviders(
          buildFollowupPrompt(
            title,
            fetched.posts,
            input.plugin.name,
            formatContextBlock(context),
            input.replyStyle,
            input.deliverPromise ?? false,
            gentleClose
          ),
          `follow-up "${title}"`
        )
      : [];

  return {
    generatedAt,
    postCount: fetched.posts.length,
    drafts,
    context: contextChunks,
    // Marker (not a skip) so the UI can label the box "Closing reply".
    ...(gentleClose ? { mode: "gentle_close" as const } : {}),
    wpResolved: fetched.resolved,
  };
}

/**
 * Generate and persist the follow-up drafts for a thread. Overwrites any
 * previous followupJson. Called after the normal drafts are already saved, so
 * on any failure the caller can keep those first-reply drafts intact.
 *
 * Deliver-the-promise: if the thread has a standing followupPromisedAt (the
 * watcher detected the team promised an update) or `force` is set (the manual
 * "Draft anyway" on a support-last skip), we draft the delivering reply instead
 * of skipping. Either way the promise reminder is retired here — Regenerate is
 * the human actively working the thread, so the "you forgot" flag has done its
 * job. This clearing lives on the manual follow-up step (not the shared
 * first-reply core) so a bulk/watcher first-reply draft never wrongly retires a
 * pending promise.
 */
export async function generateFollowupForThread(
  threadId: string,
  options?: { force?: boolean }
): Promise<FollowupResult> {
  const thread = await prisma.supportThread.findUniqueOrThrow({
    where: { id: threadId },
    include: {
      plugin: {
        select: {
          id: true,
          name: true,
          brand: { select: { replyStyle: true } },
        },
      },
    },
  });

  const deliverPromise =
    (options?.force ?? false) || thread.followupPromisedAt != null;

  // Gentle close: the team replied last (waitingSince set) and the customer has
  // been silent past WPORG_SILENCE_NUDGE_DAYS. draftFollowup only acts on it
  // when the LIVE thread still shows support posting last (a fresh customer
  // reply since then reverts to the normal draft).
  const gentleClose = isSilenceNudgeDue(
    thread.waitingSince,
    getEnv().WPORG_SILENCE_NUDGE_DAYS
  );

  // wpResolved is read off the same fetch but persisted to its own column, not
  // into followupJson — split it out so `result` stays a clean FollowupResult.
  const { wpResolved, ...result } = await draftFollowup({
    url: thread.url,
    title: thread.title,
    plugin: { id: thread.plugin.id, name: thread.plugin.name },
    replyStyle: thread.plugin.brand?.replyStyle ?? null,
    deliverPromise,
    gentleClose,
  });

  // Retire the promise reminder ONLY when a real drafting attempt happened.
  // A skipped pass (wp.org unreachable, no replies) delivered nothing — nulling
  // the reminder there would silently drop it with no way to re-arm until the
  // team posts again, which is exactly what the reminder exists to prevent.
  // Regenerate is a live observation of the thread, so it also maintains the
  // waiting clock the watcher normally owns. Support posted last with no
  // promise (a support_last skip or a gentle-close draft) and no clock running
  // yet: start it, backdated to the best-known moment we learned the team had
  // answered (the reply date when the watcher recorded one, else the PREVIOUS
  // follow-up pass that first saw the support-last state) — without this, a
  // topic whose team reply never appeared in the feed could wait forever
  // without ever surfacing in "Needs resolved". A normal draft means the
  // customer has spoken since: stop the clock.
  const supportLastObserved =
    result.skipped === "support_last" || result.mode === "gentle_close";
  const priorGeneratedAt = (() => {
    const prior = thread.followupJson as { generatedAt?: string } | null;
    const parsed = prior?.generatedAt ? new Date(prior.generatedAt) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  })();
  const waitingSincePatch = supportLastObserved
    ? thread.followupPromisedAt == null && thread.waitingSince == null
      ? { waitingSince: thread.lastReplyAt ?? priorGeneratedAt ?? new Date() }
      : {}
    : result.skipped
      ? {}
      : { waitingSince: null };

  await prisma.supportThread.update({
    where: { id: threadId },
    data: {
      followupJson: result as object,
      // Refresh the resolution flag when a page was actually fetched (non-null);
      // a transient fetch failure leaves the stored value untouched.
      ...(wpResolved !== null ? { wpResolved } : {}),
      ...(result.skipped ? {} : { followupPromisedAt: null }),
      ...waitingSincePatch,
    },
  });

  return result;
}
