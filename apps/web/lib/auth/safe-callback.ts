/**
 * Sanitiser for the `callbackUrl` Auth.js appends when it bounces someone to
 * the sign-in page. The value arrives in the query string, so it is entirely
 * attacker-controlled: a link like
 * `/signin?callbackUrl=https://evil.example` would otherwise let a phisher use
 * our own domain to redirect people after a real, successful sign-in.
 *
 * Only same-origin paths survive. A leading "/" is NOT enough on its own —
 * browsers read "//evil.example" as protocol-relative and "/\evil.example" the
 * same way, both absolute despite the leading slash.
 */
export function safeCallbackUrl(raw: string | undefined | null): string {
  if (typeof raw !== "string" || raw === "") return "/";
  if (!raw.startsWith("/")) return "/";
  // Reject every scheme-ish second character; "/" and "\" are the two a
  // browser treats as the start of an authority.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
