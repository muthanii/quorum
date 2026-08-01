import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkRateLimit,
  clientIpFromRequest,
  enforceRateLimit,
  type RateLimitStore,
} from "./rate-limit";

/**
 * Fixed-window store with a hand-cranked clock — the whole point of the
 * injectable store is that these tests never touch a live Redis.
 */
function fakeStore(): RateLimitStore & { advance(ms: number): void } {
  const entries = new Map<string, { count: number; expiresAtMs: number }>();
  let now = 0;
  return {
    advance(ms) {
      now += ms;
    },
    async hit(key, windowSec) {
      const existing = entries.get(key);
      const entry =
        existing && existing.expiresAtMs > now
          ? existing
          : { count: 0, expiresAtMs: now + windowSec * 1_000 };
      entry.count += 1;
      entries.set(key, entry);
      return { count: entry.count, ttlMs: entry.expiresAtMs - now };
    },
  };
}

const throwingStore: RateLimitStore = {
  async hit() {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  },
};

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://internal/api/boards", { method: "POST", headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkRateLimit", () => {
  it("allows every request under the limit and counts down remaining", async () => {
    const store = fakeStore();
    const opts = { key: "rl:test:a", limit: 3, windowSec: 60, store };

    expect(await checkRateLimit(opts)).toMatchObject({ allowed: true, remaining: 2 });
    expect(await checkRateLimit(opts)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await checkRateLimit(opts)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("blocks the request past the limit and reports when the window resets", async () => {
    const store = fakeStore();
    const opts = { key: "rl:test:a", limit: 2, windowSec: 60, store };
    await checkRateLimit(opts);
    await checkRateLimit(opts);

    const blocked = await checkRateLimit(opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBe(60);
    expect(blocked.resetAtMs).toBeGreaterThan(Date.now());
  });

  it("reports the time left in the window, not the whole window", async () => {
    const store = fakeStore();
    const opts = { key: "rl:test:a", limit: 1, windowSec: 60, store };
    await checkRateLimit(opts);
    store.advance(45_000);

    expect(await checkRateLimit(opts)).toMatchObject({ allowed: false, retryAfterSec: 15 });
  });

  it("resets the count once the window expires", async () => {
    const store = fakeStore();
    const opts = { key: "rl:test:a", limit: 1, windowSec: 60, store };
    await checkRateLimit(opts);
    expect(await checkRateLimit(opts)).toMatchObject({ allowed: false });

    store.advance(60_001);
    expect(await checkRateLimit(opts)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("keeps separate keys independent", async () => {
    const store = fakeStore();
    await checkRateLimit({ key: "rl:test:a", limit: 1, windowSec: 60, store });
    expect(
      await checkRateLimit({ key: "rl:test:a", limit: 1, windowSec: 60, store }),
    ).toMatchObject({ allowed: false });

    expect(
      await checkRateLimit({ key: "rl:test:b", limit: 1, windowSec: 60, store }),
    ).toMatchObject({ allowed: true });
  });

  it("fails open and warns when the store is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await checkRateLimit({
      key: "rl:test:a",
      limit: 1,
      windowSec: 60,
      store: throwingStore,
    });

    expect(result).toMatchObject({ allowed: true, remaining: 1, retryAfterSec: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    const line: unknown = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line).toMatchObject({ level: "warn", event: "rate_limit.unavailable" });
  });
});

describe("clientIpFromRequest", () => {
  it("takes the first entry of an x-forwarded-for chain", () => {
    expect(clientIpFromRequest(req({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(
      clientIpFromRequest(req({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" })),
    ).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then to a constant bucket", () => {
    expect(clientIpFromRequest(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIpFromRequest(req({ "x-forwarded-for": "  ", "x-real-ip": "198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
    expect(clientIpFromRequest(req())).toBe(clientIpFromRequest(req()));
    expect(clientIpFromRequest(req())).not.toBe("");
  });
});

describe("enforceRateLimit", () => {
  it("returns null while the caller is under the limit", async () => {
    const store = fakeStore();
    const options = { bucket: "boards.create", limit: 2, windowSec: 60, store };

    expect(await enforceRateLimit(req({ "x-forwarded-for": "203.0.113.7" }), options)).toBeNull();
    expect(await enforceRateLimit(req({ "x-forwarded-for": "203.0.113.7" }), options)).toBeNull();
  });

  it("answers 429 with Retry-After and the standard error body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = fakeStore();
    const options = { bucket: "boards.create", limit: 1, windowSec: 60, store };
    await enforceRateLimit(req({ "x-forwarded-for": "203.0.113.7" }), options);

    const response = await enforceRateLimit(req({ "x-forwarded-for": "203.0.113.7" }), options);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("60");
    expect(await response?.json()).toMatchObject({
      error: { code: "rate_limited", message: expect.stringContaining("60s") },
    });
  });

  it("buckets by client IP so one caller cannot spend another's budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = fakeStore();
    const options = { bucket: "boards.create", limit: 1, windowSec: 60, store };
    await enforceRateLimit(req({ "x-forwarded-for": "203.0.113.7" }), options);

    expect(
      await enforceRateLimit(req({ "x-forwarded-for": "203.0.113.7" }), options),
    ).not.toBeNull();
    expect(await enforceRateLimit(req({ "x-forwarded-for": "198.51.100.4" }), options)).toBeNull();
  });

  it("buckets by scope when one is given, ignoring the caller's IP", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = fakeStore();
    const options = { bucket: "agents.connect", limit: 1, windowSec: 60, store };
    await enforceRateLimit(req({ "x-forwarded-for": "203.0.113.7" }), {
      ...options,
      scope: "brd_1",
    });

    // Same board from a different IP is still the same budget…
    expect(
      await enforceRateLimit(req({ "x-forwarded-for": "198.51.100.4" }), {
        ...options,
        scope: "brd_1",
      }),
    ).not.toBeNull();
    // …and a different board is untouched.
    expect(
      await enforceRateLimit(req({ "x-forwarded-for": "203.0.113.7" }), {
        ...options,
        scope: "brd_2",
      }),
    ).toBeNull();
  });

  it("lets the request through when the store is down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      await enforceRateLimit(req(), {
        bucket: "boards.create",
        limit: 1,
        windowSec: 60,
        store: throwingStore,
      }),
    ).toBeNull();
  });
});
