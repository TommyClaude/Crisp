import { prisma } from "@/lib/db";
import { ragSearch, type RagSearchResult } from "@/lib/rag/search";
import {
  availableProviders,
  generateDraftFor,
  type SuggesterProvider,
} from "./llm";

/**
 * Answer suggester: for a wp.org support thread, retrieve the most relevant
 * historical Crisp conversations + plugin docs via RAG, then (when an LLM is
 * configured) draft a reply for a human to review. Drafts are never posted
 * anywhere automatically.
 */

export interface ContextChunkSummary {
  source: "crisp_chat" | "plugin_docs" | "wporg_forum";
  similarity: number | null;
  title: string;
  link: string | null;
  excerpt: string;
  product: string | null;
}

/** One provider's draft (or its error) for a thread. */
export interface DraftItem {
  provider: SuggesterProvider;
  model: string | null;
  text: string | null;
  error: string | null;
}

export interface SuggestionResult {
  threadId: string;
  status: string;
  draftAnswer: string | null;
  draftModel: string | null;
  drafts: DraftItem[];
  contextChunks: ContextChunkSummary[];
}

const CONTEXT_LIMIT = 6;
/** Max characters of each chunk fed into the prompt. */
const PROMPT_CHUNK_CHARS = 1200;

export function toContextSummary(result: RagSearchResult): ContextChunkSummary {
  if (
    (result.source === "plugin_docs" || result.source === "wporg_forum") &&
    result.docsPage
  ) {
    return {
      source: result.source,
      similarity: result.similarity,
      title: result.docsPage.title ?? result.docsPage.url,
      link: result.docsPage.url,
      excerpt: result.chunkText.slice(0, 400),
      product: result.product,
    };
  }
  return {
    source: "crisp_chat",
    similarity: result.similarity,
    title: result.conversation
      ? `Chat with ${result.conversation.visitorNickname ?? "visitor"} (${result.conversation.sessionId})`
      : "Archived chat",
    link: result.conversation
      ? `/crisp/conversations/${result.conversation.sessionId}`
      : null,
    excerpt: result.chunkText.slice(0, 400),
    product: result.product,
  };
}

/**
 * Retrieve context for a thread: plugin-scoped first, and when that is too
 * thin (<3 hits) widen to the plugin's OWN BRAND only — never to a fully
 * unscoped search. Grounding must stay within the brand so a topic for one
 * plugin can't be answered from a different brand's chats or docs. If the
 * brand-scoped widening finds nothing extra, the thin plugin-scoped result is
 * the honest answer.
 */
export async function retrieveContext(
  query: string,
  pluginId: string
): Promise<RagSearchResult[]> {
  const scoped = await ragSearch(query, { limit: CONTEXT_LIMIT, pluginId });
  if (scoped.results.length >= 3) return scoped.results;

  // Resolve the plugin's brand once so the widening pass stays in-brand.
  const plugin = await prisma.plugin.findUnique({
    where: { id: pluginId },
    select: { brandId: true },
  });
  if (!plugin?.brandId) return scoped.results;

  const wide = await ragSearch(query, {
    limit: CONTEXT_LIMIT,
    brandId: plugin.brandId,
  });
  const seen = new Set(scoped.results.map((r) => r.chunkId));
  return [
    ...scoped.results,
    ...wide.results.filter((r) => !seen.has(r.chunkId)),
  ].slice(0, CONTEXT_LIMIT);
}

/**
 * Render retrieved RAG chunks as the labelled context block shared by the
 * first-reply prompt ({@link buildPrompt}) and the follow-up prompt, so both
 * ground on identically-formatted context.
 */
export function formatContextBlock(context: RagSearchResult[]): string {
  return context
    .map((result, index) => {
      const label =
        result.source === "plugin_docs"
          ? `DOCS (${result.docsPage?.url ?? "unknown"})`
          : result.source === "wporg_forum"
            ? `ANSWERED FORUM TOPIC (${result.docsPage?.url ?? "unknown"})`
            : "PAST SUPPORT CONVERSATION";
      return `--- Context ${index + 1} [${label}] ---\n${result.chunkText.slice(0, PROMPT_CHUNK_CHARS)}`;
    })
    .join("\n\n");
}

/**
 * Instruction shared by the first-reply and follow-up prompts: match the
 * support team's OWN voice as it appears in the retrieved examples (and, for
 * follow-ups, the replies already visible in the thread). Tone and format
 * only — never lift customer-specific details from those examples.
 */
export function voiceMimicryRule(includeThread: boolean): string {
  return (
    "Mimic the support team's own voice as it appears in the provided materials: the support-team turns inside the PAST SUPPORT CONVERSATION and ANSWERED FORUM TOPIC context" +
    (includeThread
      ? ", and the support replies already visible earlier in this thread"
      : "") +
    ". Match their greeting style, sign-off, emoji usage and phrasing conventions. Imitate only tone and format; never copy customer-specific details, names, order numbers or site specifics from those examples."
  );
}

/**
 * "Don't sound like an AI" ruleset shared by both drafting prompts. The
 * em-dash ban is the load-bearing tell; the rest steer the draft toward how a
 * real forum support engineer writes. A brand's explicit house-style
 * instructions (see {@link appendReplyStyle}) win if they ever conflict.
 */
export const HUMAN_VOICE_RULE =
  "Write like a busy human support engineer on a forum, not like an AI. " +
  "NEVER use em dashes (—) or en dashes (–) as punctuation; use commas, periods, or parentheses instead, the way a normal forum poster would. " +
  'Avoid phrasing that makes readers suspect a bot wrote it: reflex openers like "Great question!", "Certainly!" or "Thank you for reaching out", closers like "I hope this helps!", transition words like "delve", "furthermore", "moreover" or "additionally", formulaic three-item parallel lists, and relentlessly uniform sentence lengths. ' +
  "Use plain wording, vary your sentence length, and let a little informality through. The support team's real replies in the context and thread are your best guide. " +
  // Owner feedback on a live draft: echoing "4+ years" and the customer's
  // playful "hiccup" back at them read as unnatural parroting.
  "NEVER PARROT THE CUSTOMER: respond to the substance of what they wrote, not with their own words. Do not repeat their slang, jokes or playful phrasing back at them, do not quote their usage durations or history back ('4+ years', 'since 2019'), and do not retell their story to them; when you must reference their situation, paraphrase it briefly and neutrally in the team's own voice.";

/**
 * Append the brand's free-text house-style instructions as a clearly delimited
 * section of the system prompt. The guard text makes the style shape wording,
 * tone and format only: it takes precedence over inferred voice and the
 * anti-AI style rules, but NEVER over the grounding/correctness rules. Returns
 * the prompt unchanged when the brand has no style set.
 */
export function appendReplyStyle(
  system: string,
  replyStyle?: string | null
): string {
  const style = replyStyle?.trim();
  if (!style) return system;
  return (
    system +
    "\n\n===== BRAND HOUSE-STYLE INSTRUCTIONS =====\n" +
    "Follow these house-style notes from the support team for the wording, tone, sign-off, emoji policy and phrasing of your reply. " +
    "They reflect the team's own voice, so they take precedence over any voice you infer from the examples and over the no-em-dash / no-AI-tell style rules above if they ever conflict. " +
    "They must NEVER override the grounding and correctness rules: do not invent facts, features, settings, steps or links to satisfy the style.\n\n" +
    style +
    "\n===== END BRAND HOUSE-STYLE INSTRUCTIONS ====="
  );
}

/**
 * Build the first-reply prompt. Exported for unit testing the prompt
 * construction (grounding rules, voice/anti-AI rules, and the optional brand
 * house-style section) without hitting the LLM.
 */
export function buildPrompt(
  thread: { title: string; excerpt: string; author: string | null },
  pluginName: string,
  context: RagSearchResult[],
  replyStyle?: string | null
): { system: string; user: string } {
  const system = appendReplyStyle(
    `You are a senior support engineer for the WordPress plugin "${pluginName}". ` +
      "You draft replies to forum threads on wordpress.org for a human teammate to review and post. " +
      "Ground your answer ONLY in the provided context (past resolved support conversations, answered forum threads, and official documentation). " +
      "If the context does not contain a clear answer, say so and draft clarifying questions to ask the user instead of guessing. " +
      "Never invent features, settings, or file paths. Be friendly, concise and concrete: greet the user briefly, give numbered steps when applicable, " +
      "and reference documentation links from the context when they support the answer. " +
      voiceMimicryRule(false) +
      " " +
      HUMAN_VOICE_RULE +
      " " +
      // wp.org reviews arrive through the same pipeline as support topics; a
      // support-ticket-style reply (restating their setup, troubleshooting
      // tone) reads oddly under a five-star review (owner feedback).
      "REVIEWS AND PRAISE: when the post is a positive review or a thank-you with no open question, do NOT answer it like a support ticket. Reply with a short, warm thank-you only, shaped like: greet briefly; thank them for choosing the product; one line that reviews like this make the team's day; pass their thanks along to any teammate they mentioned by name; invite them to open a thread if they ever hit an issue; sign off. Four or five short lines total, no troubleshooting, no restating what they experienced. " +
      "Write plain text suitable for a forum reply (no markdown headings). Do not mention the context, Crisp, or that you are an AI.",
    replyStyle
  );

  const contextText = formatContextBlock(context);

  const user =
    `New forum thread on wordpress.org/support/plugin:\n\n` +
    `Title: ${thread.title}\n` +
    (thread.author ? `Author: ${thread.author}\n` : "") +
    `Body:\n${thread.excerpt || "(no body in feed)"}\n\n` +
    `Context from past support conversations and documentation:\n\n${contextText || "(no relevant context found)"}\n\n` +
    "Draft the reply now.";

  return { system, user };
}

/** Input to {@link draftSuggestion} — a thread-shaped question, no DB row. */
export interface DraftSuggestionInput {
  title: string;
  excerpt: string;
  author?: string | null;
  plugin: { id: string; name: string };
  /** The owning brand's house-style instructions, when set. */
  replyStyle?: string | null;
}

export interface DraftSuggestionResult {
  drafts: DraftItem[];
  contextChunks: ContextChunkSummary[];
  status: "new" | "drafted" | "failed";
  suggestError: string | null;
}

/**
 * Draft one reply per configured provider in parallel — one DraftItem per
 * provider, with the same refusal/empty handling for every caller. Returns []
 * when no provider is configured. Shared by the first-reply suggester and the
 * follow-up drafter so the two never drift in how they call the providers.
 */
export async function draftFromProviders(
  prompt: { system: string; user: string },
  logLabel: string
): Promise<DraftItem[]> {
  const providers = availableProviders();
  return Promise.all(
    providers.map(async (provider): Promise<DraftItem> => {
      try {
        const draft = await generateDraftFor(provider, prompt.system, prompt.user);
        return { provider, model: draft.model, text: draft.text, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Draft (${provider}) failed for ${logLabel}:`, error);
        return { provider, model: null, text: null, error: message };
      }
    })
  );
}

/**
 * Pure drafting core: build the query, retrieve RAG context, draft a reply
 * from every configured provider in parallel, and derive the status. Touches
 * no database rows — used both by the real forum flow
 * ({@link generateSuggestionForThread}) and the /test-answer playground.
 */
export async function draftSuggestion(
  input: DraftSuggestionInput
): Promise<DraftSuggestionResult> {
  const query = `${input.title}\n${input.excerpt.slice(0, 400)}`.trim();
  const context = await retrieveContext(query, input.plugin.id);
  const contextChunks = context.map(toContextSummary);

  // Draft from every configured provider in parallel — one card per provider.
  const providers = availableProviders();
  const drafts: DraftItem[] =
    providers.length > 0
      ? await draftFromProviders(
          buildPrompt(
            {
              title: input.title,
              excerpt: input.excerpt,
              author: input.author ?? null,
            },
            input.plugin.name,
            context,
            input.replyStyle
          ),
          `"${input.title}"`
        )
      : [];

  // Status only becomes "drafted" once at least one provider actually
  // produced draft text — a thread with zero drafts is never "drafted",
  // regardless of why (no provider configured, or every provider failed).
  // No LLM configured => status stays "new" with context only persisted; the
  // UI shows the retrieved chunks so a human can compose the reply, and the
  // topic still counts as missing a draft. All providers failing => "failed".
  let status: "new" | "drafted" | "failed";
  let suggestError: string | null = null;
  const firstOk = drafts.find((draft) => draft.text);
  if (firstOk) {
    status = "drafted";
  } else if (providers.length > 0) {
    status = "failed";
    suggestError = drafts
      .map((draft) => `${draft.provider}: ${draft.error ?? "empty"}`)
      .join("; ");
  } else {
    status = "new";
  }

  return { drafts, contextChunks, status, suggestError };
}

export async function generateSuggestionForThread(
  threadId: string
): Promise<SuggestionResult> {
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

  const { drafts, contextChunks, status, suggestError } = await draftSuggestion({
    title: thread.title,
    excerpt: thread.excerpt,
    author: thread.author,
    plugin: { id: thread.plugin.id, name: thread.plugin.name },
    replyStyle: thread.plugin.brand?.replyStyle ?? null,
  });

  // Primary draft = the first provider that produced text (back-compat + the
  // forum watcher's drafted counter).
  const firstOk = drafts.find((draft) => draft.text);
  const draftAnswer = firstOk?.text ?? null;
  const draftModel = firstOk?.model ?? null;

  await prisma.supportThread.update({
    where: { id: threadId },
    data: {
      status,
      draftAnswer,
      draftModel,
      draftsJson: drafts as object[],
      contextJson: contextChunks as object[],
      suggestError,
      // (Re)generating drafts is the admin acting on the topic — clear the
      // "New reply" flag so a resurfaced thread stops showing the badge.
      hasNewReply: false,
    },
  });

  return { threadId, status, draftAnswer, draftModel, drafts, contextChunks };
}
