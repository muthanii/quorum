import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env";

const validEnv = {
  REDIS_URL: "redis://localhost:6379",
  DATABASE_URL: "postgres://quorum:quorum@localhost:5432/quorum",
  INTERNAL_API_SECRET: "internal-secret-value-abc123",
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("loadEnv", () => {
  it("parses a valid environment and derives the ws internal base URL", () => {
    const env = loadEnv({ ...validEnv });
    expect(env.redisUrl).toBe(validEnv.REDIS_URL);
    expect(env.databaseUrl).toBe(validEnv.DATABASE_URL);
    expect(env.internalApiSecret).toBe(validEnv.INTERNAL_API_SECRET);
    expect(env.wsInternalBaseUrl).toBe("http://localhost:3001");
  });

  it("derives the ws URL from a custom WS_PORT", () => {
    expect(loadEnv({ ...validEnv, WS_PORT: "4002" }).wsInternalBaseUrl).toBe(
      "http://localhost:4002",
    );
  });

  it("fails fast when required variables are missing, naming them", () => {
    expect(() => loadEnv({})).toThrowError(/REDIS_URL/);
    expect(() => loadEnv({})).toThrowError(/DATABASE_URL/);
    expect(() => loadEnv({})).toThrowError(/INTERNAL_API_SECRET/);
  });

  it("rejects an encryption key that is not 32 base64 bytes", () => {
    expect(() => loadEnv({ ...validEnv, CREDENTIALS_ENCRYPTION_KEY: "dG9vc2hvcnQ=" })).toThrowError(
      /CREDENTIALS_ENCRYPTION_KEY/,
    );
  });

  it("rejects an out-of-range WS_PORT", () => {
    expect(() => loadEnv({ ...validEnv, WS_PORT: "70000" })).toThrowError(/WS_PORT/);
  });

  it("never echoes secret values in its error message", () => {
    const partial = { INTERNAL_API_SECRET: "super-secret-value" };
    try {
      loadEnv(partial);
      expect.unreachable("loadEnv should have thrown");
    } catch (err) {
      expect(String(err)).not.toContain("super-secret-value");
    }
  });
});
