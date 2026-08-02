import { afterEach, describe, expect, it } from "vitest";

import { enforceRateLimit, type RateLimitStore } from "./rate-limit";

/**
 * Regression: ISSUE-004 — the shipped 10/min boards.create ceiling applies to
 * one shared `ip:unknown` bucket when no proxy header is present, so the
 * self-seeding e2e suite failed 8/18 specs with 429.
 * Found by /qa on 2026-08-01
 * Report: .gstack/qa-reports/qa-report-quorum-2026-08-01.md
 */

function fakeStore(): RateLimitStore {
  const entries = new Map<string, number>();
  return {
    async hit(key, windowSec) {
      const count = (entries.get(key) ?? 0) + 1;
      entries.set(key, count);
      return { count, ttlMs: windowSec * 1_000 };
    },
  };
}

function req(): Request {
  return new Request("http://localhost:3000/api/boards", { method: "POST" });
}

const ENV_KEY = "RATE_LIMIT_BOARDS_CREATE";
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

/** Requests allowed before the first 429, capped so a broken override can't hang. */
async function allowedBefore429(store: RateLimitStore, ceiling = 40): Promise<number> {
  for (let sent = 0; sent < ceiling; sent += 1) {
    if (await enforceRateLimit(req(), { bucket: "boards.create", limit: 10, windowSec: 60, store }))
      return sent;
  }
  return ceiling;
}

describe("per-bucket limit override", () => {
  it("raises the ceiling so a self-seeding suite is not blocked at 10", async () => {
    process.env[ENV_KEY] = "25";
    expect(await allowedBefore429(fakeStore())).toBe(25);
  });

  it("keeps the route default when unset — production is unchanged", async () => {
    delete process.env[ENV_KEY];
    expect(await allowedBefore429(fakeStore())).toBe(10);
  });

  it.each(["0", "-5", "abc", "10.5", "   "])(
    "ignores the unusable override %j rather than disabling the limit",
    async (value) => {
      process.env[ENV_KEY] = value;
      expect(await allowedBefore429(fakeStore())).toBe(10);
    },
  );

  it("scopes the override to its own bucket", async () => {
    process.env[ENV_KEY] = "25";
    const store = fakeStore();
    // A different bucket must not inherit boards.create's raised ceiling.
    let allowed = 0;
    while (
      allowed < 40 &&
      !(await enforceRateLimit(req(), {
        bucket: "agents.connect",
        limit: 10,
        windowSec: 60,
        store,
      }))
    ) {
      allowed += 1;
    }
    expect(allowed).toBe(10);
  });
});
