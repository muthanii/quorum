import { describe, expect, it } from "vitest";

import { originFromRequest } from "./origin";

function req(headers: Record<string, string>): Request {
  return new Request("http://internal/api/whatever", { headers });
}

describe("originFromRequest", () => {
  it("uses the Host the caller actually reached us on", () => {
    expect(originFromRequest(req({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    // The tailnet / LAN cases that make share links usable from a phone.
    expect(originFromRequest(req({ host: "100.83.196.2:3000" }))).toBe("http://100.83.196.2:3000");
    expect(originFromRequest(req({ host: "192.168.31.232:3000" }))).toBe(
      "http://192.168.31.232:3000",
    );
  });

  it("assumes TLS for public hostnames and plain http for dev ranges", () => {
    expect(originFromRequest(req({ host: "quorum.app" }))).toBe("https://quorum.app");
    expect(originFromRequest(req({ host: "127.0.0.1:3000" }))).toBe("http://127.0.0.1:3000");
    expect(originFromRequest(req({ host: "10.1.2.3:3000" }))).toBe("http://10.1.2.3:3000");
  });

  it("honours proxy headers ahead of Host", () => {
    expect(
      originFromRequest(
        req({
          host: "internal:3000",
          "x-forwarded-host": "quorum.app",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://quorum.app");
  });

  it("takes the first proto from a comma-joined forwarded chain", () => {
    expect(originFromRequest(req({ host: "quorum.app", "x-forwarded-proto": "https,http" }))).toBe(
      "https://quorum.app",
    );
  });

  it("falls back to the configured URL when the Host header is missing or malformed", () => {
    // Header injection attempts must not end up inside a link we hand back.
    const malformed = originFromRequest(req({ host: "evil.com/path?x=1" }));
    expect(malformed).not.toContain("evil.com/path");
    expect(originFromRequest(req({ host: "has space" }))).not.toContain("has space");
  });
});
