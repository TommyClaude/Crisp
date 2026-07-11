import { z } from "zod";

/**
 * Server-side environment validation. Import ONLY from server code
 * (API routes, server components, scripts) — never from client components,
 * so Crisp/OpenAI credentials can never leak into the browser bundle.
 */
const envSchema = z.object({
  // Legacy single-website fallback — brands (each with its own Crisp
  // website ID) are managed in the Brand table / /brands UI. Only used when
  // that table is empty.
  CRISP_WEBSITE_ID: z.string().optional(),
  // Global Crisp REST API token — a Crisp Marketplace plugin production
  // token, which (once approved) reaches every workspace the plugin is
  // installed on. Every brand authenticates with this single token.
  CRISP_IDENTIFIER: z.string().optional().or(z.literal("")),
  CRISP_KEY: z.string().optional().or(z.literal("")),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection URL"),
  OPENAI_API_KEY: z.string().optional().or(z.literal("")),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  // ── Answer suggester (Phase 3) — all optional ──────────────────────────
  // Provider for drafting forum replies: "anthropic" | "openai" | "auto".
  // "auto" picks Anthropic when ANTHROPIC_API_KEY is set, else OpenAI when
  // OPENAI_API_KEY is set, else runs context-only (no draft generation).
  SUGGESTER_PROVIDER: z.enum(["auto", "anthropic", "openai"]).default("auto"),
  ANTHROPIC_API_KEY: z.string().optional().or(z.literal("")),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),
  OPENAI_CHAT_MODEL: z.string().default("gpt-4o-mini"),
  // Base URL for wp.org support-forum feeds ({base}/{slug}/feed/). Only
  // overridden in tests.
  WPORG_FEED_BASE: z
    .string()
    .default("https://wordpress.org/support/plugin"),
  // Forum topics whose feed publish date is older than this many days at
  // check time are skipped — never stored, never drafted. Quiet forums keep
  // ancient items in their RSS feed; this stops years-old topics from wasting
  // requests, DB rows, and LLM calls. Topics with no publish date are kept.
  WPORG_TOPIC_MAX_AGE_DAYS: z.coerce.number().int().positive().default(30),
  BASIC_AUTH_USER: z.string().optional(),
  BASIC_AUTH_PASSWORD: z.string().optional(),
  CRISP_REQUEST_INTERVAL_MS: z.coerce.number().int().positive().default(150),
  CRISP_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/** Validate and return the environment. Throws a readable error when invalid. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n` +
        "Copy .env.example to .env and fill in the values (see README)."
    );
  }
  cached = parsed.data;
  return cached;
}

/** True when an OpenAI key is configured, i.e. embeddings can be generated. */
export function embeddingsConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.OPENAI_API_KEY && env.OPENAI_API_KEY.length > 0);
}
