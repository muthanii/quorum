/**
 * Zod-validated environment for the ws server. Loaded once at boot by
 * server.ts; a missing or malformed variable fails fast with the offending
 * KEYS (never the values — AUTH_SECRET / INTERNAL_API_SECRET must not leak
 * into logs or error messages).
 */
import { z } from "zod";

export const envSchema = z.object({
  WS_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  INTERNAL_API_SECRET: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid ws environment — ${details} (see .env.example)`);
  }
  return parsed.data;
}
