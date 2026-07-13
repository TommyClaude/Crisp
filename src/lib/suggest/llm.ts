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
// Reasoning models (gpt-5.x) spend hidden thinking tokens from this same
// budget, so it must be well above the length of the visible draft.
const MAX_DRAFT_TOKENS = 4096;
// Tiny cap for one-word triage calls (e.g. the follow-up promise YES/NO
// classifier) — enough for the answer, cheap, and never a full draft.
export const MAX_CLASSIFY_TOKENS = 10;

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

// Newer models on either provider reject/deprecate `temperature` with an HTTP
// 400 (owner hit this live: Anthropic — "`temperature` is deprecated for this
// model"). Model-name guessing is fragile, so instead: try WITH the field,
// and on a 400 that names it, retry once WITHOUT and remember per provider
// for the rest of the process lifetime.
const temperatureRejectedBy: Record<"anthropic" | "openai", boolean> = {
  anthropic: false,
  openai: false,
};

function isTemperatureRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("HTTP 400") &&
    /temperature/i.test(error.message)
  );
}

async function draftWithAnthropic(
  system: string,
  userPrompt: string,
  maxTokens: number = MAX_DRAFT_TOKENS,
  temperature?: number
): Promise<DraftResult> {
  const env = getEnv();
  const model = env.ANTHROPIC_MODEL;
  const url = "https://api.anthropic.com/v1/messages";
  const headers = {
    "x-api-key": env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
  };
  const payload = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
  };
  const withTemp = temperature != null && !temperatureRejectedBy.anthropic;
  let body;
  try {
    body = await postJson(
      url,
      headers,
      withTemp ? { ...payload, temperature } : payload
    );
  } catch (error) {
    if (!withTemp || !isTemperatureRejection(error)) throw error;
    temperatureRejectedBy.anthropic = true;
    body = await postJson(url, headers, payload);
  }

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
  userPrompt: string,
  maxTokens: number = MAX_DRAFT_TOKENS,
  temperature?: number
): Promise<DraftResult> {
  const env = getEnv();
  const model = env.OPENAI_CHAT_MODEL;
  // gpt-5.x / o-series reject a non-default `temperature` outright (like
  // `max_tokens` below) — skip it there up front; the catch below covers any
  // future model this prefix guess misses.
  const supportsTemperature = !/^(gpt-5|o\d)/i.test(model);
  const url = "https://api.openai.com/v1/chat/completions";
  const headers = { Authorization: `Bearer ${env.OPENAI_API_KEY}` };
  const payload = {
    model,
    // gpt-5.x / o-series reject `max_tokens`; `max_completion_tokens` is
    // the replacement and is accepted by older chat models too.
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
  };
  const withTemp =
    temperature != null && supportsTemperature && !temperatureRejectedBy.openai;
  let body;
  try {
    body = await postJson(
      url,
      headers,
      withTemp ? { ...payload, temperature } : payload
    );
  } catch (error) {
    if (!withTemp || !isTemperatureRejection(error)) throw error;
    temperatureRejectedBy.openai = true;
    body = await postJson(url, headers, payload);
  }
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned an empty draft");
  return { text, model: body.model ?? model };
}

/**
 * Generate a draft from a specific provider. `maxTokens` defaults to the full
 * draft budget; pass a small cap (e.g. {@link MAX_CLASSIFY_TOKENS}) for a terse
 * one-word triage call. `temperature` is optional and omitted from the request
 * when undefined (and always omitted for OpenAI models that reject it); pass 0
 * for judgement-style calls that should answer the same way every run.
 */
export function generateDraftFor(
  provider: SuggesterProvider,
  system: string,
  userPrompt: string,
  maxTokens?: number,
  temperature?: number
): Promise<DraftResult> {
  return provider === "anthropic"
    ? draftWithAnthropic(system, userPrompt, maxTokens, temperature)
    : draftWithOpenAI(system, userPrompt, maxTokens, temperature);
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
