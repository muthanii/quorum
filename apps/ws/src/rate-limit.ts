/**
 * Fixed-window rate limiting for agent turns (CLAUDE.md §8, "rate-limit per
 * agent and per board").
 *
 * The worker's concurrency throttles how fast WE drain the queue, not how
 * much a member can push into it: anyone in a board can spam @mentions and
 * stack unbounded jobs, which turns Quorum into an amplifier pointed at a
 * third party's HTTPS endpoint. The budget therefore has to be charged at
 * enqueue time, before the job exists.
 *
 * Both buckets are counted in one round trip, and a refused turn still counts
 * against the board: a spammer must not be able to stay under every per-agent
 * bucket by cycling through the roster.
 *
 * Fails OPEN. A limiter that stops a board from working whenever Redis
 * hiccups is a worse outage than the abuse it prevents.
 */
import { z } from "zod";

import { serializeError, type Logger } from "./log";

/** Fixed window. Short enough that a legitimate burst clears within one conversational beat. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Per agent: ~1 turn every 6s is far above conversational pace and far below what an endpoint owner would call abuse. */
export const AGENT_TURNS_PER_WINDOW = 10;

/** Per board: room for a broadcast across a full roster, but it caps the whole room's blast radius. */
export const BOARD_TURNS_PER_WINDOW = 30;

const KEY_PREFIX = "quorum:rl:turn";

/**
 * INCR both buckets and stamp the TTL only on the write that created the key.
 * A plain pipeline cannot express that condition, and an unconditional EXPIRE
 * would push the deadline out on every hit — under sustained load the window
 * would never roll and the counter would never reset.
 */
const INCR_WINDOW = `
local counts = {}
for i = 1, #KEYS do
  local n = redis.call('INCR', KEYS[i])
  if n == 1 then redis.call('PEXPIRE', KEYS[i], ARGV[1]) end
  counts[i] = n
end
return counts
`;

/** The slice of ioredis the limiter uses — narrow so tests inject a fake. */
export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export type RateLimitScope = "agent" | "board";

export type RateLimitVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Which bucket refused. */
      scope: RateLimitScope;
      /** That bucket's ceiling per window. */
      limit: number;
      windowMs: number;
      /**
       * True only for the first refusal in this window. Callers announce that
       * one in chat and stay quiet for the rest of the burst, so the notice
       * never becomes the flood it is reporting.
       */
      firstOverLimit: boolean;
    };

export interface TurnRateLimiter {
  /** Charge one turn against both buckets and say whether it may be enqueued. */
  checkTurn(input: { boardId: string; agentId: string }): Promise<RateLimitVerdict>;
}

export interface TurnRateLimiterDeps {
  redis: RateLimitRedis;
  log: Logger;
  agentLimit?: number;
  boardLimit?: number;
  windowMs?: number;
  now?: () => number;
}

/** Lua returns the two counters in key order; anything else is not trustworthy. */
const countsSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);

export function createTurnRateLimiter(deps: TurnRateLimiterDeps): TurnRateLimiter {
  const { redis, log } = deps;
  const agentLimit = deps.agentLimit ?? AGENT_TURNS_PER_WINDOW;
  const boardLimit = deps.boardLimit ?? BOARD_TURNS_PER_WINDOW;
  const windowMs = deps.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const now = deps.now ?? Date.now;

  return {
    async checkTurn({ boardId, agentId }) {
      // The window index lives in the key, so a rolled window starts from a
      // fresh counter instead of inheriting the old one's remaining TTL.
      const window = Math.floor(now() / windowMs);

      let raw: unknown;
      try {
        raw = await redis.eval(
          INCR_WINDOW,
          2,
          `${KEY_PREFIX}:agent:${agentId}:${window}`,
          `${KEY_PREFIX}:board:${boardId}:${window}`,
          windowMs,
        );
      } catch (error) {
        log.warn("turn rate limiter unavailable — failing open", {
          boardId,
          agentId,
          ...serializeError(error),
        });
        return { allowed: true };
      }

      const parsed = countsSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn("turn rate limiter returned an unexpected reply — failing open", {
          boardId,
          agentId,
        });
        return { allowed: true };
      }

      const [agentCount, boardCount] = parsed.data;
      if (agentCount > agentLimit) {
        return {
          allowed: false,
          scope: "agent",
          limit: agentLimit,
          windowMs,
          firstOverLimit: agentCount === agentLimit + 1,
        };
      }
      if (boardCount > boardLimit) {
        return {
          allowed: false,
          scope: "board",
          limit: boardLimit,
          windowMs,
          firstOverLimit: boardCount === boardLimit + 1,
        };
      }
      return { allowed: true };
    },
  };
}
