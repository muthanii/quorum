/**
 * Worker environment — validated with zod, fails fast at boot (main.ts calls
 * loadEnv() before anything else). Error messages name the offending
 * variables but NEVER echo their values.
 */
import { z } from "zod";

const KEY_BYTES = 32;

const envSchema = z.object({
  REDIS_URL: z.string().url(),
  /** Read by @quorum/db at call time; validated here so we fail at boot, not mid-turn. */
  DATABASE_URL: z.string().url(),
  /** Bearer for the ws server's /internal/* routes. */
  INTERNAL_API_SECRET: z.string().min(1),
  /**
   * Read by @quorum/db/crypto when decrypting agent credentials; validated
   * here so a missing/short key surfaces at boot instead of on the first turn.
   */
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((raw) => Buffer.from(raw, "base64").length === KEY_BYTES, {
      message: `must be base64 for exactly ${KEY_BYTES} bytes`,
    }),
  WS_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});

export interface WorkerEnv {
  redisUrl: string;
  databaseUrl: string;
  internalApiSecret: string;
  /** The ws server's internal HTTP API, derived from WS_PORT. */
  wsInternalBaseUrl: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    // Variable names and constraint text only — values never appear here.
    throw new Error(`worker environment is invalid — ${problems}`);
  }
  return {
    redisUrl: parsed.data.REDIS_URL,
    databaseUrl: parsed.data.DATABASE_URL,
    internalApiSecret: parsed.data.INTERNAL_API_SECRET,
    wsInternalBaseUrl: `http://localhost:${parsed.data.WS_PORT}`,
  };
}
