import { describe, expect, it } from "vitest";

import {
  MEMBER_PALETTE,
  colorForUser,
  contrastingTextColor,
  fnv1a32,
  relativeLuminance,
} from "../src/colors";

const BOARD_BACKGROUND = "#0b0c0e";

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

describe("MEMBER_PALETTE", () => {
  it("has exactly 12 distinct lowercase hex colors", () => {
    expect(MEMBER_PALETTE).toHaveLength(12);
    expect(new Set(MEMBER_PALETTE).size).toBe(12);
    for (const color of MEMBER_PALETTE) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("every color reaches at least 4.5:1 contrast on the dark canvas", () => {
    for (const color of MEMBER_PALETTE) {
      expect(contrast(color, BOARD_BACKGROUND)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("fnv1a32", () => {
  it("matches the published FNV-1a test vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });
});

describe("colorForUser", () => {
  it("is deterministic — same id, same color, every call", () => {
    const id = "usr_V1StGXR8_Z5jdHi6";
    const first = colorForUser(id);
    for (let i = 0; i < 10; i++) {
      expect(colorForUser(id)).toBe(first);
    }
  });

  it("is pinned to the hash (a new session or platform cannot change it)", () => {
    // fnv1a32("foobar") = 0xbf9cf968 → index 4
    expect(colorForUser("foobar")).toBe(MEMBER_PALETTE[4]);
    expect(colorForUser("")).toBe(MEMBER_PALETTE[0x811c9dc5 % 12]);
  });

  it("reaches all 12 palette entries across many users", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(colorForUser(`usr_${i}`));
    }
    expect(seen.size).toBe(12);
  });
});

describe("contrastingTextColor", () => {
  it("puts dark text on every palette color", () => {
    for (const color of MEMBER_PALETTE) {
      expect(contrastingTextColor(color)).toBe("#0b0c0e");
    }
  });

  it("puts white text on dark backgrounds", () => {
    expect(contrastingTextColor("#0b0c0e")).toBe("#ffffff");
    expect(contrastingTextColor("#1a1b1e")).toBe("#ffffff");
    expect(contrastingTextColor("#000")).toBe("#ffffff");
  });

  it("supports 3-digit shorthand and rejects malformed input", () => {
    expect(contrastingTextColor("#fff")).toBe("#0b0c0e");
    expect(() => contrastingTextColor("red")).toThrow(TypeError);
    expect(() => contrastingTextColor("#12345")).toThrow(TypeError);
    expect(() => contrastingTextColor("")).toThrow(TypeError);
  });
});
