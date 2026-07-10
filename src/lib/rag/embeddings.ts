import { embeddingsConfigured, getEnv } from "@/env";

/**
 * Minimal OpenAI embeddings client (plain fetch — no SDK dependency).
 * Only used when OPENAI_API_KEY is configured; callers must check
 * `embeddingsConfigured()` (or use `embedTextsIfConfigured`).
 */

export const EMBEDDING_DIMENSIONS = 1536;

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const BATCH_SIZE = 64;
const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestEmbeddings(inputs: string[]): Promise<number[][]> {
  const env = getEnv();
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.OPENAI_EMBEDDING_MODEL,
          input: inputs,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
        cache: "no-store",
      });
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`OpenAI embeddings network error: ${String(error)}`);
      }
      await sleep(2000 * 2 ** attempt);
      continue;
    }

    if (response.ok) {
      const body = (await response.json()) as {
        data: Array<{ index: number; embedding: number[] }>;
      };
      // OpenAI returns entries in order, but sort by index to be safe.
      return body.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    }

    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < MAX_RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after")) * 1000 || 0;
      await sleep(Math.max(2000 * 2 ** attempt, retryAfter));
      continue;
    }

    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `OpenAI embeddings request failed: HTTP ${response.status} ${errorBody.slice(0, 300)}`
    );
  }
}

/** Embed texts in batches. Throws when OPENAI_API_KEY is missing. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!embeddingsConfigured()) {
    throw new Error("OPENAI_API_KEY is not configured — cannot embed texts");
  }
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // The embeddings endpoint rejects empty strings.
    const safeBatch = batch.map((t) => (t.trim().length > 0 ? t : " "));
    vectors.push(...(await requestEmbeddings(safeBatch)));
  }
  // Guard against a model that ignores the `dimensions` parameter: a wrong
  // width would fail the pgvector insert, or worse, silently produce
  // meaningless cosine scores in the JSON fallback path.
  const badVector = vectors.find((v) => v.length !== EMBEDDING_DIMENSIONS);
  if (badVector) {
    throw new Error(
      `Embedding model "${getEnv().OPENAI_EMBEDDING_MODEL}" returned ` +
        `${badVector.length}-dimensional vectors; expected ${EMBEDDING_DIMENSIONS}. ` +
        "Use a model that supports the dimensions parameter (e.g. text-embedding-3-small)."
    );
  }
  return vectors;
}

/** Embed texts, or return null when embeddings are not configured. */
export async function embedTextsIfConfigured(
  texts: string[]
): Promise<number[][] | null> {
  if (!embeddingsConfigured()) return null;
  return embedTexts(texts);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
