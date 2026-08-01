import { describe, expect, it } from "vitest";

import { resolveWsUrl } from "./provider";

describe("resolveWsUrl", () => {
  it("keeps the configured URL when the page is served from localhost", () => {
    expect(resolveWsUrl("ws://localhost:3001", { hostname: "localhost" })).toBe(
      "ws://localhost:3001",
    );
  });

  it("follows the page host when a loopback URL is opened from another device", () => {
    // The phone/tailnet case: "localhost" would resolve to the phone itself.
    expect(resolveWsUrl("ws://localhost:3001", { hostname: "100.83.196.2" })).toBe(
      "ws://100.83.196.2:3001",
    );
    expect(resolveWsUrl("ws://127.0.0.1:3001", { hostname: "192.168.31.232" })).toBe(
      "ws://192.168.31.232:3001",
    );
  });

  it("preserves the configured port and scheme", () => {
    expect(resolveWsUrl("wss://localhost:8443", { hostname: "example.local" })).toBe(
      "wss://example.local:8443",
    );
  });

  it("never overrides a real deployment host", () => {
    // ws runs on its own host in production — the page host is irrelevant.
    expect(resolveWsUrl("wss://ws.quorum.app", { hostname: "quorum.app" })).toBe(
      "wss://ws.quorum.app",
    );
  });

  it("falls back to the configured value when there is no window (SSR)", () => {
    expect(resolveWsUrl("ws://localhost:3001", undefined)).toBe("ws://localhost:3001");
  });

  it("returns unparseable input untouched rather than throwing", () => {
    expect(resolveWsUrl("not a url", { hostname: "example.com" })).toBe("not a url");
  });
});
