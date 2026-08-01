/**
 * Zod-validated environment for the web app. SERVER-ONLY: import this from
 * server components, route handlers, and server libs only — never from a
 * "use client" module. Client code receives public values (NEXT_PUBLIC_*) as
 * props from server components, so the browser bundle never needs this file.
 *
 * Parsed eagerly at import so the app fails fast at boot with a readable
 * list of missing keys instead of failing at first use. Values are never
 * included in the error output.
 */
import { z } from "zod";

/**
 * An optional value that may legitimately arrive as "". `.env.example` ships
 * every optional key with an empty value, so a copied file sets them to ""
 * rather than leaving them unset — treat that as "not configured", or the
 * documented setup path (copy the example, fill two secrets, go) fails.
 */
function optional(schema: z.ZodString) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1),
  /** Backs API rate limiting (lib/server/rate-limit.ts) and the BullMQ queue. */
  REDIS_URL: z.string().url(),
  /** Signs Auth.js sessions, guest cookies, and the board ws JWT. */
  AUTH_SECRET: z.string().min(16),

  // OAuth / email providers are optional — a provider is skipped when unset.
  AUTH_GOOGLE_ID: optional(z.string().min(1)),
  AUTH_GOOGLE_SECRET: optional(z.string().min(1)),
  AUTH_GITHUB_ID: optional(z.string().min(1)),
  AUTH_GITHUB_SECRET: optional(z.string().min(1)),
  AUTH_RESEND_KEY: optional(z.string().min(1)),
  EMAIL_FROM: optional(z.string().min(3)),

  /** base64, exactly 32 bytes — enforced byte-exactly by @quorum/db/crypto. */
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(1),
  /** Bearer secret for the ws server's /internal API (used by later features). */
  INTERNAL_API_SECRET: optional(z.string().min(1)),

  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_WS_URL: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  // NEXT_PUBLIC_* must be referenced literally for Next's build-time inlining;
  // everything else can come straight off process.env at runtime.
  const parsed = envSchema.safeParse({
    ...process.env,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // Names and zod messages only — never env values.
    throw new Error(`Invalid environment for @quorum/web (see .env.example):\n${problems}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();
