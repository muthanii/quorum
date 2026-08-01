import { describe, expect, it } from "vitest";

import { newId } from "@quorum/shared/ids";

import type { LogFields, Logger } from "../src/log";
import {
  createTurnRateLimiter,
  type RateLimitRedis,
  type RateLimitVerdict,
} from "../src/rate-limit";

interface FakeRedis extends RateLimitRedis {
  counts: Map<string, number>;
}

/** Mirrors the script's INCR-per-key semantics without a Redis. */
function makeFakeRedis(): FakeRedis {
  const counts = new Map<string, number>();
  return {
    counts,
    async eval(_script, numKeys, ...args) {
      return args.slice(0, numKeys).map((key) => {
        const next = (counts.get(String(key)) ?? 0) + 1;
        counts.set(String(key), next);
        return next;
      });
    },
  };
}

interface RecordingLogger extends Logger {
  warnings: { msg: string; fields: LogFields }[];
}

function recordingLogger(): RecordingLogger {
  const warnings: RecordingLogger["warnings"] = [];
  const logger: RecordingLogger = {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, fields) => warnings.push({ msg, fields: fields ?? {} }),
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

const boardId = newId("board");

function setup(
  overrides: {
    redis?: RateLimitRedis;
    now?: () => number;
    agentLimit?: number;
    boardLimit?: number;
  } = {},
) {
  const redis = overrides.redis ?? makeFakeRedis();
  const log = recordingLogger();
  const limiter = createTurnRateLimiter({
    redis,
    log,
    agentLimit: overrides.agentLimit ?? 2,
    boardLimit: overrides.boardLimit ?? 3,
    windowMs: 60_000,
    now: overrides.now ?? Date.now,
  });
  return { limiter, log };
}

describe("createTurnRateLimiter", () => {
  it("allows turns up to the per-agent limit and refuses beyond it", async () => {
    const { limiter } = setup();
    const agentId = newId("agent");

    expect(await limiter.checkTurn({ boardId, agentId })).toEqual({ allowed: true });
    expect(await limiter.checkTurn({ boardId, agentId })).toEqual({ allowed: true });
    expect(await limiter.checkTurn({ boardId, agentId })).toEqual({
      allowed: false,
      scope: "agent",
      limit: 2,
      windowMs: 60_000,
      firstOverLimit: true,
    });
  });

  it("marks only the first refusal of a window as firstOverLimit", async () => {
    const { limiter } = setup();
    const agentId = newId("agent");
    for (let i = 0; i < 3; i++) await limiter.checkTurn({ boardId, agentId });

    const again = await limiter.checkTurn({ boardId, agentId });
    expect(again).toMatchObject({ allowed: false, firstOverLimit: false });
  });

  it("keeps the per-agent buckets independent", async () => {
    const { limiter } = setup({ boardLimit: 100 });
    const noisy = newId("agent");
    const quiet = newId("agent");

    for (let i = 0; i < 3; i++) await limiter.checkTurn({ boardId, agentId: noisy });
    expect(await limiter.checkTurn({ boardId, agentId: noisy })).toMatchObject({
      allowed: false,
      scope: "agent",
    });

    // The noisy agent burned its own bucket, not everyone else's.
    expect(await limiter.checkTurn({ boardId, agentId: quiet })).toEqual({ allowed: true });
  });

  it("refuses on the board bucket when several agents stay under their own", async () => {
    const { limiter } = setup();
    const agents = [newId("agent"), newId("agent"), newId("agent"), newId("agent")];

    const verdicts: RateLimitVerdict[] = [];
    for (const agentId of agents) {
      verdicts.push(await limiter.checkTurn({ boardId, agentId }));
    }

    expect(verdicts.slice(0, 3)).toEqual([{ allowed: true }, { allowed: true }, { allowed: true }]);
    expect(verdicts[3]).toEqual({
      allowed: false,
      scope: "board",
      limit: 3,
      windowMs: 60_000,
      firstOverLimit: true,
    });
  });

  it("keeps boards independent of one another", async () => {
    const { limiter } = setup();
    const other = newId("board");
    const agentId = newId("agent");

    for (let i = 0; i < 4; i++) await limiter.checkTurn({ boardId, agentId });
    expect(await limiter.checkTurn({ boardId: other, agentId: newId("agent") })).toEqual({
      allowed: true,
    });
  });

  it("starts a fresh counter when the window rolls", async () => {
    let now = 1_753_400_000_000;
    const { limiter } = setup({ now: () => now });
    const agentId = newId("agent");

    for (let i = 0; i < 3; i++) await limiter.checkTurn({ boardId, agentId });
    expect(await limiter.checkTurn({ boardId, agentId })).toMatchObject({ allowed: false });

    now += 60_000;
    expect(await limiter.checkTurn({ boardId, agentId })).toEqual({ allowed: true });
  });

  it("fails open with a warning when the store errors", async () => {
    const redis: RateLimitRedis = {
      async eval() {
        throw new Error("ECONNREFUSED");
      },
    };
    const { limiter, log } = setup({ redis });

    expect(await limiter.checkTurn({ boardId, agentId: newId("agent") })).toEqual({
      allowed: true,
    });
    expect(log.warnings[0]?.msg).toContain("failing open");
    expect(log.warnings[0]?.fields.errorMessage).toBe("ECONNREFUSED");
  });

  it("fails open when the store replies with an unexpected shape", async () => {
    const redis: RateLimitRedis = {
      async eval() {
        return "OK";
      },
    };
    const { limiter, log } = setup({ redis });

    expect(await limiter.checkTurn({ boardId, agentId: newId("agent") })).toEqual({
      allowed: true,
    });
    expect(log.warnings[0]?.msg).toContain("failing open");
  });
});
