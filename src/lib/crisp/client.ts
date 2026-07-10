import { getEnv } from "@/env";
import { CRISP_API_BASE_URL, crispEndpoints } from "./endpoints";
import type {
  CrispApiEnvelope,
  CrispConversation,
  CrispConversationMeta,
  CrispMessage,
  CrispOperatorListEntry,
} from "./types";

/** Error thrown when the Crisp API returns a non-retryable failure. */
export class CrispApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    public readonly reason?: string
  ) {
    super(message);
    this.name = "CrispApiError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin, isolated wrapper around the Crisp REST API v1.
 *
 * - Authenticates with HTTP Basic (token identifier:key) + `X-Crisp-Tier: plugin`.
 * - Serializes requests with a minimum inter-request delay to respect the
 *   Crisp rate limit.
 * - Retries retryable failures (429/5xx/network) with exponential backoff,
 *   honouring `Retry-After` when present.
 *
 * Endpoint paths live in ./endpoints.ts so they are easy to adjust.
 */
export class CrispClient {
  private readonly authHeader: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options?: {
    identifier?: string;
    key?: string;
    minIntervalMs?: number;
    maxRetries?: number;
  }) {
    const env = getEnv();
    const identifier = options?.identifier || env.CRISP_IDENTIFIER;
    const key = options?.key || env.CRISP_KEY;
    if (!identifier || !key) {
      throw new Error(
        "No Crisp token available — set the brand's token in /brands, or " +
          "CRISP_IDENTIFIER/CRISP_KEY in .env."
      );
    }
    this.minIntervalMs =
      options?.minIntervalMs ?? env.CRISP_REQUEST_INTERVAL_MS;
    this.maxRetries = options?.maxRetries ?? env.CRISP_MAX_RETRIES;
    this.authHeader =
      "Basic " + Buffer.from(`${identifier}:${key}`).toString("base64");
  }

  /** Serialize all requests through a queue so rate limiting is global. */
  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async request<T>(
    path: string,
    query?: Record<string, string | number | undefined>
  ): Promise<T> {
    return this.schedule(() => this.requestWithRetry<T>(path, query));
  }

  private async requestWithRetry<T>(
    path: string,
    query?: Record<string, string | number | undefined>
  ): Promise<T> {
    const url = new URL(CRISP_API_BASE_URL + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let attempt = 0;
    // maxRetries retries => maxRetries + 1 total attempts
    for (;;) {
      // Respect the minimum interval between requests (rate limiting).
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();

      let response: Response | null = null;
      let networkError: unknown = null;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: this.authHeader,
            "X-Crisp-Tier": "plugin",
            Accept: "application/json",
          },
          cache: "no-store",
        });
      } catch (error) {
        networkError = error;
      }

      if (response?.ok) {
        const body = (await response.json()) as CrispApiEnvelope<T>;
        if (body.error) {
          throw new CrispApiError(
            `Crisp API error on ${path}: ${body.reason}`,
            response.status,
            path,
            body.reason
          );
        }
        return body.data;
      }

      const status = response?.status ?? 0;
      const retryable = networkError !== null || RETRYABLE_STATUS.has(status);

      if (!retryable || attempt >= this.maxRetries) {
        if (networkError) {
          throw new CrispApiError(
            `Crisp API network error on ${path}: ${String(networkError)}`,
            0,
            path
          );
        }
        let reason: string | undefined;
        try {
          const body = (await response!.json()) as CrispApiEnvelope<unknown>;
          reason = body.reason;
        } catch {
          // non-JSON error body — ignore
        }
        throw new CrispApiError(
          `Crisp API request failed on ${path}: HTTP ${status}${reason ? ` (${reason})` : ""}`,
          status,
          path,
          reason
        );
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s... honouring Retry-After.
      const retryAfterHeader = response?.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : 0;
      const backoffMs = Math.max(2000 * 2 ** attempt, retryAfterMs);
      attempt += 1;
      await sleep(Math.min(backoffMs, 60_000));
    }
  }

  /** List conversations, most recently active first. Page starts at 1. */
  listConversations(
    websiteId: string,
    page: number
  ): Promise<CrispConversation[]> {
    return this.request<CrispConversation[]>(
      crispEndpoints.listConversations(websiteId, page)
    );
  }

  /** Fetch a single conversation (includes meta and assignment). */
  getConversation(
    websiteId: string,
    sessionId: string
  ): Promise<CrispConversation> {
    return this.request<CrispConversation>(
      crispEndpoints.getConversation(websiteId, sessionId)
    );
  }

  /**
   * Fetch one batch of messages (most recent first when paging backwards).
   * Pass `timestampBefore` (ms epoch) to fetch older messages.
   */
  getMessagesBatch(
    websiteId: string,
    sessionId: string,
    timestampBefore?: number
  ): Promise<CrispMessage[]> {
    return this.request<CrispMessage[]>(
      crispEndpoints.getMessages(websiteId, sessionId),
      { timestamp_before: timestampBefore }
    );
  }

  /**
   * Fetch ALL messages of a conversation by paging backwards with
   * `timestamp_before` until an empty/repeated batch is returned.
   * Result is sorted by timestamp ascending.
   */
  async getAllMessages(
    websiteId: string,
    sessionId: string
  ): Promise<CrispMessage[]> {
    const seen = new Map<string, CrispMessage>();
    let timestampBefore: number | undefined = undefined;
    // Hard cap as a safety net against pathological pagination loops.
    const MAX_BATCHES = 500;

    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = await this.getMessagesBatch(
        websiteId,
        sessionId,
        timestampBefore
      );
      if (!batch || batch.length === 0) break;

      let added = 0;
      let oldest: number = timestampBefore ?? Number.MAX_SAFE_INTEGER;
      for (const message of batch) {
        const key =
          message.fingerprint !== undefined
            ? String(message.fingerprint)
            : `${message.timestamp}-${JSON.stringify(message.content)?.slice(0, 64)}`;
        if (!seen.has(key)) {
          seen.set(key, message);
          added += 1;
        }
        if (typeof message.timestamp === "number") {
          oldest = Math.min(oldest, message.timestamp);
        }
      }

      // No new messages or no usable cursor → stop.
      if (added === 0 || oldest === Number.MAX_SAFE_INTEGER) break;
      if (timestampBefore !== undefined && oldest >= timestampBefore) break;
      timestampBefore = oldest;
    }

    return [...seen.values()].sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
    );
  }

  /** Fetch conversation metas. Returns null when the endpoint is unavailable. */
  async getConversationMetas(
    websiteId: string,
    sessionId: string
  ): Promise<CrispConversationMeta | null> {
    try {
      return await this.request<CrispConversationMeta>(
        crispEndpoints.getConversationMetas(websiteId, sessionId)
      );
    } catch (error) {
      if (error instanceof CrispApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** List operators; returns [] when the endpoint/scope is unavailable. */
  async listOperators(websiteId: string): Promise<CrispOperatorListEntry[]> {
    try {
      return await this.request<CrispOperatorListEntry[]>(
        crispEndpoints.listOperators(websiteId)
      );
    } catch {
      return [];
    }
  }
}
