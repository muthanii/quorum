import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOLERANCE_SEC,
  SIGNATURE_HEADER,
  parseSignatureHeader,
  signRequest,
  verifySignature,
} from "../src/v1/signature";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ turnId: "trn_abc123", boardId: "brd_xyz789" });
const NOW = 1_753_400_000; // arbitrary fixed unix-seconds "now"

describe("SIGNATURE_HEADER", () => {
  it("is the documented header name", () => {
    expect(SIGNATURE_HEADER).toBe("X-Quorum-Signature");
  });
});

describe("signRequest", () => {
  it("produces the documented t=...,v1=<64 hex chars> format", () => {
    const header = signRequest(SECRET, BODY, NOW);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(header.startsWith(`t=${NOW},`)).toBe(true);
  });

  it("floors fractional timestamps", () => {
    expect(signRequest(SECRET, BODY, NOW + 0.9)).toBe(signRequest(SECRET, BODY, NOW));
  });

  it("is deterministic for the same inputs", () => {
    expect(signRequest(SECRET, BODY, NOW)).toBe(signRequest(SECRET, BODY, NOW));
  });
});

describe("parseSignatureHeader", () => {
  it("parses a well-formed header", () => {
    const header = signRequest(SECRET, BODY, NOW);
    const parsed = parseSignatureHeader(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.t).toBe(NOW);
    expect(parsed?.v1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores unknown extra fields but still yields t and v1", () => {
    const header = signRequest(SECRET, BODY, NOW);
    const withExtras = `${header},v2=deadbeef,foo=bar`;
    const parsed = parseSignatureHeader(withExtras);
    expect(parsed).toEqual(parseSignatureHeader(header));
  });

  it("lowercases uppercase hex in v1", () => {
    const parsed = parseSignatureHeader(`t=${NOW},v1=ABCDEF01`);
    expect(parsed).toEqual({ t: NOW, v1: "abcdef01" });
  });

  it("returns null for garbage", () => {
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("not-a-header")).toBeNull();
    expect(parseSignatureHeader("t=,v1=")).toBeNull();
  });

  it("returns null when t is missing or non-numeric", () => {
    expect(parseSignatureHeader("v1=abcdef")).toBeNull();
    expect(parseSignatureHeader(`t=soon,v1=abcdef`)).toBeNull();
    expect(parseSignatureHeader(`t=-5,v1=abcdef`)).toBeNull();
  });

  it("returns null when v1 is missing or non-hex", () => {
    expect(parseSignatureHeader(`t=${NOW}`)).toBeNull();
    expect(parseSignatureHeader(`t=${NOW},v1=nothex!`)).toBeNull();
  });
});

describe("verifySignature", () => {
  const sign = (body: string, at: number, secret = SECRET) => signRequest(secret, body, at);

  it("round-trips: a freshly signed request verifies", () => {
    expect(
      verifySignature({ secret: SECRET, rawBody: BODY, header: sign(BODY, NOW), nowSec: NOW }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = sign(BODY, NOW);
    const tampered = BODY.replace("trn_abc123", "trn_evil99");
    expect(verifySignature({ secret: SECRET, rawBody: tampered, header, nowSec: NOW })).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = sign(BODY, NOW);
    expect(verifySignature({ secret: "whsec_wrong", rawBody: BODY, header, nowSec: NOW })).toBe(
      false,
    );
  });

  it("rejects an expired timestamp (past tolerance)", () => {
    const header = sign(BODY, NOW);
    expect(
      verifySignature({
        secret: SECRET,
        rawBody: BODY,
        header,
        nowSec: NOW + DEFAULT_TOLERANCE_SEC + 1,
      }),
    ).toBe(false);
  });

  it("rejects a far-future timestamp", () => {
    const header = sign(BODY, NOW + DEFAULT_TOLERANCE_SEC + 1);
    expect(verifySignature({ secret: SECRET, rawBody: BODY, header, nowSec: NOW })).toBe(false);
  });

  it("accepts a timestamp exactly at the tolerance boundary (both directions)", () => {
    const header = sign(BODY, NOW);
    expect(
      verifySignature({
        secret: SECRET,
        rawBody: BODY,
        header,
        nowSec: NOW + DEFAULT_TOLERANCE_SEC,
      }),
    ).toBe(true);
    expect(
      verifySignature({
        secret: SECRET,
        rawBody: BODY,
        header,
        nowSec: NOW - DEFAULT_TOLERANCE_SEC,
      }),
    ).toBe(true);
  });

  it("honors a custom toleranceSec", () => {
    const header = sign(BODY, NOW);
    const args = { secret: SECRET, rawBody: BODY, header, toleranceSec: 10 };
    expect(verifySignature({ ...args, nowSec: NOW + 10 })).toBe(true);
    expect(verifySignature({ ...args, nowSec: NOW + 11 })).toBe(false);
  });

  it("rejects missing or malformed headers", () => {
    const base = { secret: SECRET, rawBody: BODY, nowSec: NOW };
    expect(verifySignature({ ...base, header: null })).toBe(false);
    expect(verifySignature({ ...base, header: undefined })).toBe(false);
    expect(verifySignature({ ...base, header: "" })).toBe(false);
    expect(verifySignature({ ...base, header: "t=123" })).toBe(false);
    expect(verifySignature({ ...base, header: "v1=abcdef" })).toBe(false);
    expect(verifySignature({ ...base, header: "total garbage" })).toBe(false);
  });

  it("still verifies when the header carries extra unknown fields", () => {
    const header = `${sign(BODY, NOW)},v2=deadbeef,scheme=hmac`;
    expect(verifySignature({ secret: SECRET, rawBody: BODY, header, nowSec: NOW })).toBe(true);
  });

  it("accepts uppercase hex in v1", () => {
    const parsed = parseSignatureHeader(sign(BODY, NOW));
    const header = `t=${parsed?.t},v1=${parsed?.v1.toUpperCase()}`;
    expect(verifySignature({ secret: SECRET, rawBody: BODY, header, nowSec: NOW })).toBe(true);
  });

  it("does not throw on a valid-hex v1 of the wrong length", () => {
    const header = `t=${NOW},v1=abcdef`;
    expect(verifySignature({ secret: SECRET, rawBody: BODY, header, nowSec: NOW })).toBe(false);
  });
});
