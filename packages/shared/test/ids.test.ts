import { describe, expect, it } from "vitest";

import { ID_KINDS, PREFIXES, idSchema, isId, newId } from "../src/ids";

describe("newId", () => {
  it("produces <prefix> + 16 url-safe chars for every kind", () => {
    for (const kind of ID_KINDS) {
      const id = newId(kind);
      expect(id.startsWith(PREFIXES[kind])).toBe(true);
      expect(id.length).toBe(PREFIXES[kind].length + 16);
      expect(id.slice(PREFIXES[kind].length)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    }
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("user")));
    expect(ids.size).toBe(1000);
  });
});

describe("isId", () => {
  it("round-trips newId for every kind", () => {
    for (const kind of ID_KINDS) {
      expect(isId(kind, newId(kind))).toBe(true);
    }
  });

  it("rejects ids of a different kind", () => {
    const userId = newId("user");
    for (const kind of ID_KINDS) {
      if (kind === "user") continue;
      expect(isId(kind, userId)).toBe(false);
    }
  });

  it("rejects malformed values", () => {
    expect(isId("user", "usr_short")).toBe(false);
    expect(isId("user", `usr_${"x".repeat(17)}`)).toBe(false);
    expect(isId("user", `usr_${"!".repeat(16)}`)).toBe(false);
    expect(isId("user", "usr-abcdefghij123456")).toBe(false);
    expect(isId("user", "")).toBe(false);
    expect(isId("user", 42)).toBe(false);
    expect(isId("user", null)).toBe(false);
    expect(isId("user", undefined)).toBe(false);
  });

  it("accepts underscores and dashes in the body (nanoid alphabet)", () => {
    expect(isId("board", "brd_ab_cd-ef12345678")).toBe(true);
  });
});

describe("idSchema", () => {
  it("parses a valid id of the right kind", () => {
    for (const kind of ID_KINDS) {
      const id = newId(kind);
      expect(idSchema(kind).parse(id)).toBe(id);
    }
  });

  it("rejects wrong-kind and malformed ids", () => {
    expect(idSchema("board").safeParse(newId("user")).success).toBe(false);
    expect(idSchema("board").safeParse("brd_tooshort").success).toBe(false);
    expect(idSchema("board").safeParse(123).success).toBe(false);
  });

  it("mentions the expected prefix in its error", () => {
    const result = idSchema("agent").safeParse("nope");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("agt_");
    }
  });
});
