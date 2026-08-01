/**
 * Absolute URLs that are handed back to the caller — share links, invite
 * redirects — must point at the host that caller is actually using.
 *
 * NEXT_PUBLIC_APP_URL is a single build-time constant, so relying on it alone
 * means a board opened over the LAN, a tailnet, or a tunnel hands out links
 * pointing somewhere the recipient's device cannot reach. Deriving the origin
 * from the request keeps "sharing is one click" true from any address, and
 * falls back to the configured value when there is no usable Host header.
 */
/**
 * Read straight off process.env rather than importing the validated `env`
 * module: this helper is pure enough to unit test, and pulling in the eager
 * boot-time parse would make it untestable without a full environment.
 * NEXT_PUBLIC_APP_URL is still validated at startup by lib/env.ts.
 */
function configuredOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/** Hosts we will echo back into a link without a configured allowlist. */
function isPlausibleHost(host: string): boolean {
  // Reject anything with credentials, paths, or whitespace smuggled in.
  return /^[a-zA-Z0-9.\-[\]:]+$/.test(host) && host.length <= 255;
}

export function originFromRequest(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host");
  if (!host || !isPlausibleHost(host)) return configuredOrigin();

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto =
    forwardedProto ??
    // Plain http is only reasonable for loopback and private-range dev hosts;
    // anything else is assumed to be served over TLS.
    (/^(localhost|127\.|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      host,
    )
      ? "http"
      : "https");

  return `${proto}://${host}`;
}
