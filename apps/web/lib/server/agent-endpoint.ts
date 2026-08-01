/**
 * Hostname sanity check for agent endpoint URLs at registration time
 * (addendum #6). This is deliberately a fast, DNS-free gate: HTTPS only, no
 * embedded credentials, and no obviously-internal hosts. FULL SSRF
 * enforcement (DNS resolution against private/reserved/metadata ranges)
 * lives in the worker at call time — both layers must pass.
 */

export class AgentEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEndpointError";
  }
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "0.0.0.0"]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** Private/reserved IPv4 literals — rejected without DNS. */
const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export function assertSaneAgentEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AgentEndpointError("Endpoint must be a valid absolute URL.");
  }
  if (url.protocol !== "https:") {
    throw new AgentEndpointError("Endpoint must use https://.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AgentEndpointError("Endpoint URL must not embed credentials.");
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new AgentEndpointError("Endpoint host looks internal — use a public HTTPS URL.");
  }
  // IPv6 literals (URL strips the brackets, leaving ":") are rejected
  // outright at this layer; the worker's resolver-based check is the place
  // for nuanced IPv6 handling.
  if (hostname.includes(":")) {
    throw new AgentEndpointError("IPv6 literal endpoints are not supported — use a hostname.");
  }
  if (IPV4_LITERAL.test(hostname) && PRIVATE_IPV4_PATTERNS.some((p) => p.test(hostname))) {
    throw new AgentEndpointError("Endpoint IP is in a private or reserved range.");
  }
  return url;
}
