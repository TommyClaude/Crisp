import { prisma } from "@/lib/db";
import { ragSearch, type RagSearchResult } from "@/lib/rag/search";
import { generateDraft, suggesterConfigured } from "./llm";

/**
 * Answer suggester: for a wp.org support thread, retrieve the most relevant
 * historical Crisp conversations + plugin docs via RAG, then (when an LLM is
 * configured) draft a reply for a human to review. Drafts are never posted
 * anywhere automatically.
 */

export interface ContextChunkSummary {
  source: "crisp_chat" | "plugin_docs";
  similarity: number | null;
  title: string;
  link: string | null;
  excerpt: string;
  product: string | null;
}

export interface SuggestionResult {
  threadId: string;
  status: string;
  draftAnswer: string | null;
  draftModel: string | null;
  contextChunks: ContextChunkSummary[];
}

const CONTEXT_LIMIT = 6;
/** Max characters of each chunk fed into the prompt. */
const PROMPT_CHUNK_CHARS = 1200;

function toContextSummary(result: RagSearchResult): ContextChunkSummary {
  if (result.source === "plugin_docs" && result.docsPage) {
    return {
      source: "plugin_docs",
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
      ? `/conversations/${result.conversation.sessionId}`
      : null,
    excerpt: result.chunkText.slice(0, 400),
    product: result.product,
  };
}

/** Retrieve context for a thread: plugin-scoped first, widen if too thin. */
async function retrieveContext(
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

function buildPrompt(
  thread: { title: string; excerpt: string; author: string | null },
  pluginName: string,
  context: RagSearchResult[]
): { system: string; user: string } {
  const system =
    `You are a senior support engineer for the WordPress plugin "${pluginName}". ` +
    "You draft replies to forum threads on wordpress.org for a human teammate to review and post. " +
    "Ground your answer ONLY in the provided context (past resolved support conversations and official documentation). " +
    "If the context does not contain a clear answer, say so and draft clarifying questions to ask the user instead of guessing. " +
    "Never invent features, settings, or file paths. Be friendly, concise and concrete: greet the user briefly, give numbered steps when applicable, " +
    "and reference documentation links from the context when they support the answer. " +
    "Write plain text suitable for a forum reply (no markdown headings). Do not mention the context, Crisp, or that you are an AI.";

  const contextText = context
    .map((result, index) => {
      const label =
        result.source === "plugin_docs"
          ? `DOCS (${result.docsPage?.url ?? "unknown"})`
          : "PAST SUPPORT CONVERSATION";
      return `--- Context ${index + 1} [${label}] ---\n${result.chunkText.slice(0, PROMPT_CHUNK_CHARS)}`;
    })
    .join("\n\n");

  const user =
    `New forum thread on wordpress.org/support/plugin:\n\n` +
    `Title: ${thread.title}\n` +
    (thread.author ? `Author: ${thread.author}\n` : "") +
    `Body:\n${thread.excerpt || "(no body in feed)"}\n\n` +
    `Context from past support conversations and documentation:\n\n${contextText || "(no relevant context found)"}\n\n` +
    "Draft the reply now.";

  return { system, user };
}

export async function generateSuggestionForThread(
  threadId: string
): Promise<SuggestionResult> {
  const thread = await prisma.supportThread.findUniqueOrThrow({
    where: { id: threadId },
    include: { plugin: { select: { id: true, name: true } } },
  });

  const query = `${thread.title}\n${thread.excerpt.slice(0, 400)}`.trim();
  const context = await retrieveContext(query, thread.plugin.id);
  const contextChunks = context.map(toContextSummary);

  let draftAnswer: string | null = null;
  let draftModel: string | null = null;
  let status = "drafted";
  let suggestError: string | null = null;

  if (suggesterConfigured()) {
    try {
      const prompt = buildPrompt(thread, thread.plugin.name, context);
      const draft = await generateDraft(prompt.system, prompt.user);
      draftAnswer = draft.text;
      draftModel = draft.model;
    } catch (error) {
      status = "failed";
      suggestError = error instanceof Error ? error.message : String(error);
      console.error(`Draft generation failed for thread ${threadId}:`, error);
    }
  }
  // No LLM configured → status stays "drafted" with context only; the UI
  // shows the retrieved chunks so a human can compose the reply.

  await prisma.supportThread.update({
    where: { id: threadId },
    data: {
      status,
      draftAnswer,
      draftModel,
      contextJson: contextChunks as object[],
      suggestError,
    },
  });

  return { threadId, status, draftAnswer, draftModel, contextChunks };
}
