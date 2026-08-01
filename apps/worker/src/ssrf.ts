/**
 * SSRF guard for user-supplied agent endpoints (CLAUDE.md §8, brief addendum
 * #7). The worker is the component that actually dials user URLs, so this is
 * the enforcement point: HTTPS only, and neither the hostname nor ANY address
 * it resolves to may fall in a private / reserved / metadata range (IPv4 and
 * IPv6, including IPv4-mapped and NAT64-embedded forms).
 *
 * DNS rebinding: we resolve once, verify every returned address, and return
 * the first verified address as `pinnedAddress` so a caller can pin its
 * connection to it. LIMITATION — Node's global fetch performs its own lookup
 * internally and cannot be handed a pre-resolved address without a custom
 * undici dispatcher (undici is not a declared dependency of this app), so
 * between our check and fetch's lookup a hostile DNS server could swap in a
 * private address. The residual window is narrow (verify-then-fetch within
 * milliseconds, `redirect: "error"` on every call, all addresses of the
 * answer verified — not just the first), and `pinnedAddress` is surfaced so
 * a future dispatcher (connect to the pinned IP with TLS servername kept as
 * the hostname) can close it without changing callers.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable DNS resolver so tests can simulate SSRF without touching the network. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type SsrfErrorCode =
  "invalid_url" | "not_https" | "blocked_host" | "blocked_address" | "dns_failed";

export class SsrfError extends Error {
  readonly code: SsrfErrorCode;

  constructor(code: SsrfErrorCode, message: string) {
    super(message);
    this.name = "SsrfError";
    this.code = code;
  }
}

export interface PublicUrlCheck {
  url: URL;
  hostname: string;
  /** Every address the hostname resolved to — all verified public. */
  addresses: string[];
  /** The verified address a caller should pin its connection to. */
  pinnedAddress: string;
}

const defaultResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

function ipv4Bytes(ip: string): number[] {
  return ip.split(".").map((part) => Number(part));
}

/** Expand a (pre-validated) IPv6 literal to its 16 bytes. Zone ids are dropped. */
function ipv6Bytes(ip: string): number[] {
  let addr = ip;
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  const [headStr = "", tailStr = ""] = addr.split("::");
  const parseSide = (side: string): number[] => {
    if (side === "") return [];
    const bytes: number[] = [];
    for (const group of side.split(":")) {
      if (group.includes(".")) bytes.push(...ipv4Bytes(group));
      else {
        const value = Number.parseInt(group, 16);
        bytes.push((value >> 8) & 0xff, value & 0xff);
      }
    }
    return bytes;
  };
  const head = parseSide(headStr);
  const tail = parseSide(tailStr);
  const fill = Math.max(0, 16 - head.length - tail.length);
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

function blockedIPv4Range(bytes: number[]): string | null {
  const [a = -1, b = -1, c = -1] = bytes;
  if (a === 0) return "0.0.0.0/8 (this network)";
  if (a === 10) return "10.0.0.0/8 (private)";
  if (a === 100 && b >= 64 && b <= 127) return "100.64.0.0/10 (carrier-grade NAT)";
  if (a === 127) return "127.0.0.0/8 (loopback)";
  if (a === 169 && b === 254) return "169.254.0.0/16 (link-local / cloud metadata)";
  if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 (private)";
  if (a === 192 && b === 0 && c === 0) return "192.0.0.0/24 (IETF reserved)";
  if (a === 192 && b === 0 && c === 2) return "192.0.2.0/24 (TEST-NET-1)";
  if (a === 192 && b === 168) return "192.168.0.0/16 (private)";
  if (a === 198 && (b === 18 || b === 19)) return "198.18.0.0/15 (benchmarking)";
  if (a === 198 && b === 51 && c === 100) return "198.51.100.0/24 (TEST-NET-2)";
  if (a === 203 && b === 0 && c === 113) return "203.0.113.0/24 (TEST-NET-3)";
  if (a >= 224 && a <= 239) return "224.0.0.0/4 (multicast)";
  if (a >= 240) return "240.0.0.0/4 (reserved / broadcast)";
  return null;
}

function blockedIPv6Range(bytes: number[]): string | null {
  const at = (i: number): number => bytes[i] ?? 0;
  if (bytes.every((x) => x === 0)) return ":: (unspecified)";
  if (bytes.slice(0, 15).every((x) => x === 0) && at(15) === 1) return "::1 (loopback)";
  // IPv4-mapped ::ffff:0:0/96 — the connection actually goes to the embedded IPv4.
  if (bytes.slice(0, 10).every((x) => x === 0) && at(10) === 0xff && at(11) === 0xff) {
    const inner = blockedIPv4Range(bytes.slice(12));
    return inner === null ? null : `IPv4-mapped ${inner}`;
  }
  // IPv4-compatible ::/96 is deprecated and ambiguous — block outright.
  if (bytes.slice(0, 12).every((x) => x === 0)) return "::/96 (IPv4-compatible, deprecated)";
  // NAT64 64:ff9b::/96 — judged by the embedded IPv4 it translates to.
  if (
    at(0) === 0x00 &&
    at(1) === 0x64 &&
    at(2) === 0xff &&
    at(3) === 0x9b &&
    bytes.slice(4, 12).every((x) => x === 0)
  ) {
    const inner = blockedIPv4Range(bytes.slice(12));
    return inner === null ? null : `NAT64-embedded ${inner}`;
  }
  if (at(0) === 0x01 && at(1) === 0x00 && bytes.slice(2, 8).every((x) => x === 0)) {
    return "100::/64 (discard)";
  }
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) {
    return "2001:db8::/32 (documentation)";
  }
  if ((at(0) & 0xfe) === 0xfc) return "fc00::/7 (unique local)";
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return "fe80::/10 (link-local)";
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0xc0) return "fec0::/10 (deprecated site-local)";
  if (at(0) === 0xff) return "ff00::/8 (multicast)";
  return null;
}

/** Name of the blocked range an IP literal falls in, or null when it is public. */
export function blockedRangeForIp(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) return blockedIPv4Range(ipv4Bytes(ip));
  if (family === 6) return blockedIPv6Range(ipv6Bytes(ip));
  return "not an IP address";
}

function assertHostnameAllowed(hostname: string): void {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal"
  ) {
    throw new SsrfError("blocked_host", `hostname "${hostname}" is not a public host`);
  }
}

/**
 * Assert `rawUrl` is an https:// URL whose host is public, resolving DNS when
 * the host is a name. Throws SsrfError otherwise. See the module comment for
 * the rebinding caveat on `pinnedAddress`.
 */
export async function assertPublicHttpsUrl(
  rawUrl: string,
  opts: { resolve?: Resolver } = {},
): Promise<PublicUrlCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid_url", "agent endpoint is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new SsrfError("not_https", `agent endpoints must use https:// (got ${url.protocol})`);
  }

  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname === "") throw new SsrfError("invalid_url", "agent endpoint has no host");
  assertHostnameAllowed(hostname);

  if (isIP(hostname) !== 0) {
    const range = blockedRangeForIp(hostname);
    if (range !== null) {
      throw new SsrfError("blocked_address", `address ${hostname} is in ${range}`);
    }
    return { url, hostname, addresses: [hostname], pinnedAddress: hostname };
  }

  const resolve = opts.resolve ?? defaultResolver;
  let resolved: ResolvedAddress[];
  try {
    resolved = await resolve(hostname);
  } catch {
    throw new SsrfError("dns_failed", `DNS lookup failed for "${hostname}"`);
  }
  const first = resolved[0];
  if (first === undefined) {
    throw new SsrfError("dns_failed", `"${hostname}" resolved to no addresses`);
  }
  // Reject if ANY answer is non-public: multi-record answers mixing a public
  // and a private address are a classic rebinding/round-robin trick.
  for (const { address } of resolved) {
    const range = blockedRangeForIp(address);
    if (range !== null) {
      throw new SsrfError(
        "blocked_address",
        `"${hostname}" resolves to ${address} which is in ${range}`,
      );
    }
  }
  return {
    url,
    hostname,
    addresses: resolved.map((r) => r.address),
    pinnedAddress: first.address,
  };
}
