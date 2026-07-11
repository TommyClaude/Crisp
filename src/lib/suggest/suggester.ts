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

/** Retrieve context for a thread: plugin-scoped first, widen if too thin. */
export async function retrieveContext(
  query: string,
  pluginId: string
): Promise<RagSearchResult[]> {
  const scoped = await ragSearch(query, { limit: CONTEXT_LIMIT, pluginId });
  if (scoped.results.length >= 3) return scoped.results;

  const wide = await ragSearch(query, { limit: CONTEXT_LIMIT });
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

function buildPrompt(
  thread: { title: string; excerpt: string; author: string | null },
  pluginName: string,
  context: RagSearchResult[]
): { system: string; user: string } {
  const system =
    `You are a senior support engineer for the WordPress plugin "${pluginName}". ` +
    "You draft replies to forum threads on wordpress.org for a human teammate to review and post. " +
    "Ground your answer ONLY in the provided context (past resolved support conversations, answered forum threads, and official documentation). " +
    "If the context does not contain a clear answer, say so and draft clarifying questions to ask the user instead of guessing. " +
    "Never invent features, settings, or file paths. Be friendly, concise and concrete: greet the user briefly, give numbered steps when applicable, " +
    "and reference documentation links from the context when they support the answer. " +
    "Write plain text suitable for a forum reply (no markdown headings). Do not mention the context, Crisp, or that you are an AI.";

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
}

export interface DraftSuggestionResult {
  drafts: DraftItem[];
  contextChunks: ContextChunkSummary[];
  status: "drafted" | "failed";
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

  let status: "drafted" | "failed" = "drafted";
  let suggestError: string | null = null;

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
            context
          ),
          `"${input.title}"`
        )
      : [];

  // All providers failing => status "failed". No LLM configured => status
  // stays "drafted" with context only; the UI shows the retrieved chunks so a
  // human can compose the reply.
  const firstOk = drafts.find((draft) => draft.text);
  if (providers.length > 0 && !firstOk) {
    status = "failed";
    suggestError = drafts
      .map((draft) => `${draft.provider}: ${draft.error ?? "empty"}`)
      .join("; ");
  }

  return { drafts, contextChunks, status, suggestError };
}

export async function generateSuggestionForThread(
  threadId: string
): Promise<SuggestionResult> {
  const thread = await prisma.supportThread.findUniqueOrThrow({
    where: { id: threadId },
    include: { plugin: { select: { id: true, name: true } } },
  });

  const { drafts, contextChunks, status, suggestError } = await draftSuggestion({
    title: thread.title,
    excerpt: thread.excerpt,
    author: thread.author,
    plugin: { id: thread.plugin.id, name: thread.plugin.name },
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
    },
  });

  return { threadId, status, draftAnswer, draftModel, drafts, contextChunks };
}
