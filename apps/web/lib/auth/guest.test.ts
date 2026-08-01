import { describe, expect, it } from "vitest";

import { newId } from "@quorum/shared/ids";

import {
  guestCookieOptions,
  GUEST_SESSION_MAX_AGE_SEC,
  signGuestToken,
  verifyGuestToken,
} from "./guest";

const SECRET = "test-secret-at-least-sixteen-chars";

describe("guest token roundtrip", () => {
  it("signs and verifies claims intact", async () => {
    const sub = newId("user");
    const token = await signGuestToken({ sub, name: "Guest 1a2b" }, SECRET);
    const claims = await verifyGuestToken(token, SECRET);
    expect(claims).toEqual({ sub, name: "Guest 1a2b" });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signGuestToken({ sub: newId("user"), name: "Guest" }, SECRET);
    expect(await verifyGuestToken(token, "another-secret-also-long-enough")).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const token = await signGuestToken({ sub: newId("user"), name: "Guest" }, SECRET);
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: newId("user"), name: "Mallory" }),
      "utf8",
    ).toString("base64url");
    const forged = [header, forgedPayload, signature].join(".");
    expect(await verifyGuestToken(forged, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signGuestToken({ sub: newId("user"), name: "Guest" }, SECRET, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await verifyGuestToken(token, SECRET)).toBeNull();
  });

  it("rejects structurally valid JWTs whose sub is not a usr_ id", async () => {
    const token = await signGuestToken(
      // Bypass the type to simulate a foreign-but-correctly-signed token.
      { sub: "brd_0123456789abcdef" as never, name: "Guest" },
      SECRET,
    );
    expect(await verifyGuestToken(token, SECRET)).toBeNull();
  });

  it("rejects garbage input", async () => {
    expect(await verifyGuestToken("not-a-jwt", SECRET)).toBeNull();
    expect(await verifyGuestToken("", SECRET)).toBeNull();
  });
});

describe("guest cookie options", () => {
  it("is httpOnly, lax, path=/ with the 30-day max age", () => {
    const options = guestCookieOptions();
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: GUEST_SESSION_MAX_AGE_SEC,
    });
  });
});
