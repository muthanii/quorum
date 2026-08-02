/**
 * Regression: ISSUE-006 — /api/auth/signin rendered a blank page with no
 * provider configured. The replacement /signin page accepts Auth.js's
 * attacker-controlled `callbackUrl`, so it must never redirect off-origin.
 * Found by /qa on 2026-08-01
 * Report: .gstack/qa-reports/qa-report-quorum-2026-08-01-signin.md
 */
import { describe, expect, it } from "vitest";

import { safeCallbackUrl } from "./safe-callback";

describe("safeCallbackUrl", () => {
  it("keeps a same-origin path so sign-in returns you where you were", () => {
    expect(safeCallbackUrl("/b/brd_abc123")).toBe("/b/brd_abc123");
  });

  it("keeps the query string and hash on that path", () => {
    expect(safeCallbackUrl("/b/brd_abc?tab=chat#msg-3")).toBe("/b/brd_abc?tab=chat#msg-3");
  });

  it.each([undefined, null, ""])("falls back home for %j", (value) => {
    expect(safeCallbackUrl(value)).toBe("/");
  });

  it.each([
    "https://evil.example/steal",
    "http://evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "evil.example",
  ])("refuses the absolute or scheme-bearing target %j", (value) => {
    expect(safeCallbackUrl(value)).toBe("/");
  });

  it.each(["//evil.example", "//evil.example/path", "/\\evil.example"])(
    "refuses %j, which a browser reads as protocol-relative despite the leading slash",
    (value) => {
      expect(safeCallbackUrl(value)).toBe("/");
    },
  );
});
