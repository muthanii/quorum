/**
 * Quorum Agent Protocol v1 — webhook signature helpers.
 *
 * Every request Quorum sends to an agent endpoint carries:
 *
 *   X-Quorum-Signature: t=<unix seconds>,v1=<hex hmac-sha256 over "<t>.<rawBody>">
 *
 * Agents must verify it before trusting the payload. Only node:crypto is
 * used so this file can be vendored without any dependencies.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Quorum-Signature";

/** Default acceptable clock skew between signer and verifier, in seconds. */
export const DEFAULT_TOLERANCE_SEC = 300;

function hmacHex(secret: string, timestampSec: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
}

/**
 * Produce the value for the X-Quorum-Signature header.
 * `timestampSec` is explicit (no hidden clock reads) so signing is deterministic.
 */
export function signRequest(secret: string, rawBody: string, timestampSec: number): string {
  const t = Math.floor(timestampSec);
  return `t=${t},v1=${hmacHex(secret, t, rawBody)}`;
}

/**
 * Parse a signature header value into its parts. Unknown fields are ignored
 * (the format may gain fields later); returns null when `t` or `v1` is
 * missing or malformed.
 */
export function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (!/^\d+$/.test(value)) return null;
      t = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-fA-F]+$/.test(value)) return null;
      v1 = value.toLowerCase();
    }
  }
  if (t === null || v1 === null) return null;
  return { t, v1 };
}

export interface VerifySignatureInput {
  secret: string;
  rawBody: string;
  /** The raw X-Quorum-Signature header value (absent headers verify false). */
  header: string | null | undefined;
  /** Unix seconds "now" — passed in so verification is testable and clock-free. */
  nowSec: number;
  /** Max |nowSec - t| in seconds. Defaults to 300. */
  toleranceSec?: number;
}

/**
 * Constant-time verification of a signed request. False on any failure:
 * missing/malformed header, stale or future timestamp, or MAC mismatch.
 */
export function verifySignature(input: VerifySignatureInput): boolean {
  const { secret, rawBody, header, nowSec, toleranceSec = DEFAULT_TOLERANCE_SEC } = input;
  if (!header) return false;

  const parsed = parseSignatureHeader(header);
  if (parsed === null) return false;
  if (Math.abs(Math.floor(nowSec) - parsed.t) > toleranceSec) return false;

  const expected = Buffer.from(hmacHex(secret, parsed.t, rawBody), "utf8");
  const provided = Buffer.from(parsed.v1, "utf8");
  // timingSafeEqual throws on length mismatch; a length check leaks nothing
  // useful (the digest length is public), so guard explicitly.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
