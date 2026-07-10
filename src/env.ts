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
  CRISP_IDENTIFIER: z.string().min(1, "CRISP_IDENTIFIER is required"),
  CRISP_KEY: z.string().min(1, "CRISP_KEY is required"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection URL"),
  OPENAI_API_KEY: z.string().optional().or(z.literal("")),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
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
