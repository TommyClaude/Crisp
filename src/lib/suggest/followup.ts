import { prisma } from "@/lib/db";
import {
  fetchTopicThread,
  type ForumPost,
} from "@/lib/wporg/forum-crawler";
import { availableProviders } from "./llm";
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
  skipped?: "no_replies" | "fetch_failed";
}

export interface DraftFollowupInput {
  url: string;
  title: string;
  plugin: { id: string; name: string };
  /** The owning brand's house-style instructions, when set. */
  replyStyle?: string | null;
}

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
  replyStyle?: string | null
): { system: string; user: string } {
  const system = appendReplyStyle(
    `You are a senior support engineer for the WordPress plugin "${pluginName}". ` +
      "You are drafting the NEXT reply your support team should post in an ongoing wordpress.org forum thread, for a human teammate to review and post. " +
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

  const user =
    `Ongoing forum thread on wordpress.org/support/plugin:\n\n` +
    `Title: ${title}\n\n` +
    `Conversation so far (oldest first):\n\n${buildTranscript(posts)}\n\n` +
    `Context from past support conversations and documentation:\n\n${contextText || "(no relevant context found)"}\n\n` +
    "First decide silently (do not write this out) whether the customer's most recent message is closing the conversation (resolved / thanks / review left), still needs help, or does both at once (a thank-you plus a brand-new question), then output ONLY the support team's next reply.";

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
): Promise<FollowupResult> {
  const generatedAt = new Date().toISOString();

  const fetched = await fetchTopicThread(input.url);
  if (!fetched) {
    return { generatedAt, postCount: 0, drafts: [], context: [], skipped: "fetch_failed" };
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
            input.replyStyle
          ),
          `follow-up "${title}"`
        )
      : [];

  return { generatedAt, postCount: fetched.posts.length, drafts, context: contextChunks };
}

/**
 * Generate and persist the follow-up drafts for a thread. Overwrites any
 * previous followupJson. Called after the normal drafts are already saved, so
 * on any failure the caller can keep those first-reply drafts intact.
 */
export async function generateFollowupForThread(
  threadId: string
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

  const result = await draftFollowup({
    url: thread.url,
    title: thread.title,
    plugin: { id: thread.plugin.id, name: thread.plugin.name },
    replyStyle: thread.plugin.brand?.replyStyle ?? null,
  });

  await prisma.supportThread.update({
    where: { id: threadId },
    data: { followupJson: result as object },
  });

  return result;
}
