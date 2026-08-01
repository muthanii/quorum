import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env";

const VALID = {
  DATABASE_URL: "postgres://quorum:quorum@localhost:5432/quorum",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "auth-secret",
  INTERNAL_API_SECRET: "internal-secret",
};

describe("loadEnv", () => {
  it("parses a valid environment and defaults WS_PORT to 3001", () => {
    const env = loadEnv(VALID);
    expect(env.WS_PORT).toBe(3001);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
  });

  it("coerces WS_PORT from a string", () => {
    expect(loadEnv({ ...VALID, WS_PORT: "4001" }).WS_PORT).toBe(4001);
  });

  it("fails fast on a missing variable, naming the key but never a value", () => {
    const { AUTH_SECRET: _omitted, ...incomplete } = VALID;
    expect(() => loadEnv(incomplete)).toThrow(/AUTH_SECRET/);
    try {
      loadEnv(incomplete);
    } catch (error) {
      expect((error as Error).message).not.toContain(VALID.INTERNAL_API_SECRET);
      expect((error as Error).message).not.toContain(VALID.DATABASE_URL);
    }
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadEnv({ ...VALID, WS_PORT: "70000" })).toThrow(/WS_PORT/);
  });
});
