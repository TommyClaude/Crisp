import { getEnv } from "@/env";

/**
 * Minimal provider-agnostic chat-completion client for drafting forum
 * replies (raw HTTP by design — the LLM provider is a deploy-time choice via
 * SUGGESTER_PROVIDER, and this optional feature shouldn't pull in two SDKs).
 *
 * Provider resolution ("auto"): Anthropic when ANTHROPIC_API_KEY is set,
 * else OpenAI when OPENAI_API_KEY is set, else none — callers fall back to
 * context-only suggestions.
 */

export type SuggesterProvider = "anthropic" | "openai";

export interface DraftResult {
  text: string;
  model: string;
}

const FETCH_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const MAX_DRAFT_TOKENS = 1500;

export function resolveProvider(): SuggesterProvider | null {
  return availableProviders()[0] ?? null;
}

/**
 * Every provider that should draft a reply, in display order. With
 * SUGGESTER_PROVIDER="auto" (default) this is every provider that has an API
 * key — so both Anthropic and OpenAI draft when both keys are set. An explicit
 * "anthropic"/"openai" preference pins it to that single provider.
 */
export function availableProviders(): SuggesterProvider[] {
  const env = getEnv();
  const preference = env.SUGGESTER_PROVIDER;
  const all: SuggesterProvider[] = [];
  if (env.ANTHROPIC_API_KEY) all.push("anthropic");
  if (env.OPENAI_API_KEY) all.push("openai");
  if (preference === "anthropic") return all.filter((p) => p === "anthropic");
  if (preference === "openai") return all.filter((p) => p === "openai");
  return all;
}

export function suggesterConfigured(): boolean {
  return availableProviders().length > 0;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      if (response.ok) return await response.json();

      const retryable = [429, 500, 502, 503, 529].includes(response.status);
      const errorBody = await response.text().catch(() => "");
      if (!retryable || attempt >= MAX_RETRIES) {
        throw new Error(
          `LLM request failed: HTTP ${response.status} ${errorBody.slice(0, 300)}`
        );
      }
      const retryAfter = Number(response.headers.get("retry-after")) * 1000 || 0;
      await new Promise((r) => setTimeout(r, Math.max(2000 * 2 ** attempt, retryAfter)));
    } catch (error) {
      if (attempt >= MAX_RETRIES || (error instanceof Error && error.message.startsWith("LLM request failed"))) {
        throw error;
      }
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function draftWithAnthropic(
  system: string,
  userPrompt: string
): Promise<DraftResult> {
  const env = getEnv();
  const model = env.ANTHROPIC_MODEL;
  const body = await postJson(
    "https://api.anthropic.com/v1/messages",
    {
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    {
      model,
      max_tokens: MAX_DRAFT_TOKENS,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }
  );

  if (body.stop_reason === "refusal") {
    throw new Error("The model declined to draft a reply for this topic");
  }
  const text = (body.content ?? [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("LLM returned an empty draft");
  return { text, model: body.model ?? model };
}

async function draftWithOpenAI(
  system: string,
  userPrompt: string
): Promise<DraftResult> {
  const env = getEnv();
  const model = env.OPENAI_CHAT_MODEL;
  const body = await postJson(
    "https://api.openai.com/v1/chat/completions",
    { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    {
      model,
      max_tokens: MAX_DRAFT_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
    }
  );
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned an empty draft");
  return { text, model: body.model ?? model };
}

/** Generate a draft from a specific provider. */
export function generateDraftFor(
  provider: SuggesterProvider,
  system: string,
  userPrompt: string
): Promise<DraftResult> {
  return provider === "anthropic"
    ? draftWithAnthropic(system, userPrompt)
    : draftWithOpenAI(system, userPrompt);
}

/** Generate a draft with whichever provider is configured (first available). */
export async function generateDraft(
  system: string,
  userPrompt: string
): Promise<DraftResult> {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      "No LLM provider configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY (see SUGGESTER_PROVIDER)"
    );
  }
  return generateDraftFor(provider, system, userPrompt);
}
