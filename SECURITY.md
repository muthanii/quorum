# Security Policy

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting: **Security → Advisories → Report a vulnerability** on
[this repository](https://github.com/muthanii/quorum/security/advisories/new). It reaches
the maintainers privately and gives us a place to coordinate a fix with you.

Please include what you were able to do, the steps to reproduce it, and what you think
the impact is. A working proof of concept helps a lot. You will get an acknowledgement
within 72 hours and an assessment within 7 days.

## Scope

Quorum's threat model assumes **agent output is hostile** and **agent endpoints are
attacker-supplied**. Findings in these areas are especially welcome:

| Area                         | Why it matters                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consensus integrity**      | Forging a vote, resolving your own proposal, or applying an operation without unanimous approval defeats the entire product. The ws server is the sole authority; clients may only write their own vote. |
| **SSRF via agent endpoints** | Users paste arbitrary URLs. We enforce HTTPS, block private/reserved/metadata ranges, and re-resolve DNS at dial time in the worker. A bypass reaches internal infrastructure.                           |
| **Credential exposure**      | Agent secrets are AES-256-GCM encrypted at rest and returned exactly once. Any path that leaks or logs one is a vulnerability.                                                                           |
| **Y.Doc authorization**      | A board id is not an authorization token. Reading or writing a board you are not a member of is in scope.                                                                                                |
| **XSS via agent content**    | Agent-authored markdown/HTML is sanitized with DOMPurify before render. A bypass is in scope.                                                                                                            |
| **Guest session forgery**    | Guest identity is a signed JWT backed by a real user row; minting or stealing one is in scope.                                                                                                           |

## Known limitations

These are documented tradeoffs, not undisclosed bugs. Reports about them are still
welcome if you can demonstrate impact beyond what is described.

- **DNS rebinding window.** The worker resolves an agent hostname, verifies every
  returned address, then calls `fetch`, which performs its own lookup. A hostile DNS
  server could swap in a private address inside that window. Mitigated by verifying all
  addresses (not just the first), `redirect: "error"` on every call, and a
  verify-then-fetch gap of milliseconds. `pinnedAddress` is surfaced so a future custom
  dispatcher can close it. See `apps/worker/src/ssrf.ts`.
- **Rate limits fail open.** If Redis is unreachable, requests are allowed and a warning
  is logged. A rate limiter that takes the product down when Redis blinks is worse than
  no rate limiter.
- **Shared bucket without a proxy header.** Callers with no `x-forwarded-for` share one
  rate-limit bucket. Deployments behind a proxy that sets the header are unaffected.
- **ws is a single instance by design.** Sharing `Y.Doc` state across instances needs
  `@hocuspocus/extension-redis`, which is not installed. See `DEPLOYING.md`.

## Supported versions

Pre-1.0 and not yet deployed against real traffic. Fixes land on `main`; there are no
maintained release branches yet.
