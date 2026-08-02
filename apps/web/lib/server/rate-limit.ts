/**
 * Fixed-window rate limiting over Redis for the REST routes that mint durable
 * state (users, boards, agents, invite links) — CLAUDE.md §8, "rate-limit per
 * agent and per board".
 *
 * FAIL OPEN, deliberately: when Redis is unreachable the request is allowed
 * and we log a structured warning. Quorum's promise is "paste a link and go",
 * so a Redis outage must cost us abuse protection, never lock every user out
 * of the product. Failing closed would turn one dependency's bad minute into a
 * full outage; the warning is the signal to go fix Redis.
 */
import { Redis } from "ioredis";
import type { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError } from "./http";
import { log, serializeError } from "./log";

/**
 * INCR and EXPIRE in one round trip: a connection dropped between two separate
 * commands would leave a key with no TTL, banning that caller forever. PTTL
 * rides along so the caller can report an honest Retry-After.
 */
const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('PTTL', KEYS[1])}
`;

const hitReplySchema = z.tuple([z.number(), z.number()]);

export interface RateLimitStore {
  /** INCR `key`, attaching a `windowSec` TTL on the first hit of the window. */
  hit(key: string, windowSec: number): Promise<{ count: number; ttlMs: number }>;
}

let client: Redis | null = null;

/**
 * Module singleton so a warm serverless invocation reuses the connection
 * instead of paying a handshake per request, created lazily so merely
 * importing this module never opens a socket.
 *
 * REDIS_URL is read straight off process.env rather than through lib/env,
 * whose eager boot-time parse would make this file untestable without a full
 * environment (same reasoning as lib/server/origin.ts). lib/env.ts still
 * fails the boot when REDIS_URL is missing.
 */
function getClient(): Redis {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  const created = new Redis(url, {
    lazyConnect: true,
    // Tight and bounded: a sick Redis must not add latency to a request we are
    // going to allow anyway once it fails.
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  // ioredis rethrows an 'error' event that has no listener — a dead Redis must
  // degrade to fail-open, not take the process down.
  created.on("error", (error) => log.warn("rate_limit.redis_error", serializeError(error)));
  client = created;
  return created;
}

const redisStore: RateLimitStore = {
  async hit(key, windowSec) {
    const reply = await getClient().eval(FIXED_WINDOW_SCRIPT, 1, key, windowSec);
    const [count, ttlMs] = hitReplySchema.parse(reply);
    // PTTL answers -1/-2 when the key lost its TTL or expired mid-script.
    return { count, ttlMs: ttlMs > 0 ? ttlMs : windowSec * 1_000 };
  },
};

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in this window; 0 once blocked. */
  remaining: number;
  resetAtMs: number;
  /** Seconds the caller should wait; 0 when allowed. */
  retryAfterSec: number;
}

export interface CheckRateLimitOptions {
  key: string;
  limit: number;
  windowSec: number;
  /** Injected by tests; defaults to the Redis singleton. */
  store?: RateLimitStore;
}

export async function checkRateLimit({
  key,
  limit,
  windowSec,
  store = redisStore,
}: CheckRateLimitOptions): Promise<RateLimitResult> {
  try {
    const { count, ttlMs } = await store.hit(key, windowSec);
    const allowed = count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      resetAtMs: Date.now() + ttlMs,
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil(ttlMs / 1_000)),
    };
  } catch (error) {
    log.warn("rate_limit.unavailable", { key, ...serializeError(error) });
    return {
      allowed: true,
      remaining: limit,
      resetAtMs: Date.now() + windowSec * 1_000,
      retryAfterSec: 0,
    };
  }
}

/** Bucket for callers that arrive with no proxy header (dev, direct hits). */
const UNKNOWN_CLIENT = "unknown";

/**
 * The caller's IP, for bucketing only. Vercel always sets x-forwarded-for and
 * overwrites any client-supplied value; x-real-ip covers other proxies. It is
 * a spoofable hint and is NEVER used for identity or authorization — that is
 * resolveViewer()'s job, off signed cookies.
 */
export function clientIpFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return UNKNOWN_CLIENT;
}

export interface EnforceRateLimitOptions {
  /** Names the budget, e.g. "boards.create", so routes never share a key. */
  bucket: string;
  limit: number;
  windowSec: number;
  /** What the budget belongs to (a board id). Omit to bucket by client IP. */
  scope?: string;
  store?: RateLimitStore;
}

/** `boards.create` → `RATE_LIMIT_BOARDS_CREATE`. */
function envNameForBucket(bucket: string): string {
  return `RATE_LIMIT_${bucket.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

/**
 * Per-bucket ceiling, overridable per environment.
 *
 * The shipped defaults are tuned for a public deployment behind a proxy that
 * sets x-forwarded-for, where each abuser gets their own bucket. Without that
 * header every caller shares the `ip:unknown` bucket — which is exactly the
 * local case, and why the e2e suite (18 self-seeding specs, 4 workers, one
 * apparent client) exhausted a 10/min budget and failed with 429.
 *
 * Read off process.env for the same reason as REDIS_URL above: lib/env's eager
 * boot parse would make this module untestable. A missing, non-numeric, or
 * non-positive value keeps the caller's default, so a typo can never silently
 * disable a limit.
 */
function resolveLimit(bucket: string, fallback: number): number {
  const raw = process.env[envNameForBucket(bucket)];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    log.warn("rate_limit.bad_override", { bucket, value: raw, using: fallback });
    return fallback;
  }
  return parsed;
}

/** null when the request may proceed, otherwise the 429 to return as-is. */
export async function enforceRateLimit(
  request: Request,
  { bucket, limit, windowSec, scope, store }: EnforceRateLimitOptions,
): Promise<NextResponse | null> {
  const subject = scope ?? `ip:${clientIpFromRequest(request)}`;
  const effectiveLimit = resolveLimit(bucket, limit);
  const result = await checkRateLimit({
    key: `rl:${bucket}:${subject}`,
    limit: effectiveLimit,
    windowSec,
    store,
  });
  if (result.allowed) return null;

  log.warn("rate_limit.blocked", { bucket, subject, limit: effectiveLimit, windowSec });
  const response = jsonError(
    429,
    "rate_limited",
    `Too many requests. Try again in ${result.retryAfterSec}s.`,
  );
  response.headers.set("Retry-After", String(result.retryAfterSec));
  return response;
}
