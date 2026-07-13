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
  // Grace period before a support-team follow-up promise counts as overdue.
  // When the watcher detects the team's last reply promised a further update
  // ("let me check and get back to you"), it stamps SupportThread.followup-
  // PromisedAt; the "Follow-up due" badge and the "Needs reply" queue only
  // surface it once it's older than this many days.
  WPORG_PROMISE_REMINDER_DAYS: z.coerce.number().int().positive().default(3),
  // Days of customer silence after a support-team reply (with no follow-up
  // promise) before the topic surfaces in the "Needs resolved" tab — topics
  // that can probably be closed. The watcher stamps SupportThread.waitingSince
  // on that reply; once it is older than this many days the topic appears in
  // "Needs resolved" with a "No response" badge, and its follow-up box offers a
  // gentle-close draft. Under the threshold the topic just shows a muted
  // "Waiting on customer" badge in Recent.
  WPORG_SILENCE_NUDGE_DAYS: z.coerce.number().int().positive().default(3),
  // ── wp.org email push listener (near-realtime forum updates) ─────────────
  // wordpress.org has no webhooks but emails subscribed accounts on every new
  // topic/reply. A dedicated Gmail inbox collects those forwarded "WordPress.org
  // Forums" notifications; an IMAP listener (src/lib/wporg/mail-listener.ts)
  // turns each into a targeted single-topic check within seconds, so the RSS
  // cron can be relaxed. The listener refuses to start unless ENABLED is true
  // AND both USER and PASSWORD are set; the mailbox is opened strictly
  // read-only (never marked seen, moved, or deleted).
  WPORG_MAIL_ENABLED: z.preprocess(
    (v) => v === "true" || v === "1",
    z.boolean()
  ),
  WPORG_MAIL_HOST: z.string().default("imap.gmail.com"),
  WPORG_MAIL_PORT: z.coerce.number().int().positive().default(993),
  WPORG_MAIL_USER: z.string().optional().or(z.literal("")),
  WPORG_MAIL_PASSWORD: z.string().optional().or(z.literal("")),
  // ── Slack notifications (optional) ──────────────────────────────────────
  // Slack Incoming Webhook URL. When set, the configured Slack channel gets:
  //   - a "new topic + ready draft" message for every freshly created
  //     customer-last wp.org topic (both the feed and mail ingestion paths);
  //   - a "new customer reply + suggested follow-up" message when a customer
  //     replies on an already-tracked topic (mail path only — the feed path
  //     re-processes the same reply and would double-post; see watcher.ts).
  // See src/lib/notify/slack.ts. Silently disabled when unset.
  SLACK_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  BASIC_AUTH_USER: z.string().optional(),
  BASIC_AUTH_PASSWORD: z.string().optional(),
  CRISP_REQUEST_INTERVAL_MS: z.coerce.number().int().positive().default(150),
  CRISP_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),
  // Per-source cap on crawled docs pages ("url" and "sitemap" modes). The
  // coverage panel warns when a source hits it. Raise for large docs sites.
  DOCS_CRAWL_MAX_PAGES: z.coerce.number().int().positive().default(300),
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

/**
 * True when the wp.org email-push listener has everything it needs: explicitly
 * enabled AND both an IMAP user and password. The single source of truth for
 * "should the listener run" — the listener refuses to start otherwise.
 */
export function mailListenerConfigured(): boolean {
  const env = getEnv();
  return Boolean(
    env.WPORG_MAIL_ENABLED && env.WPORG_MAIL_USER && env.WPORG_MAIL_PASSWORD
  );
}

/**
 * True when a Slack Incoming Webhook URL is configured, i.e. new-topic
 * notifications (src/lib/notify/slack.ts) should be sent. The single source
 * of truth for "should Slack notifications fire" — mirrors
 * {@link mailListenerConfigured}.
 */
export function slackConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.SLACK_WEBHOOK_URL && env.SLACK_WEBHOOK_URL.length > 0);
}
