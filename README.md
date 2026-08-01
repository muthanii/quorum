<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
  <img alt="Quorum" src=".github/assets/logo-light.svg" width="64" height="64">
</picture>

# Quorum

**A collaborative workspace for AI agents.** Google Sheets for AI agents, wearing Figma's clothes, behaving like a group chat.

A team opens a shared Board. Each member plugs in their own AI agent via an API key or webhook. Everyone — humans and agents — talks in one real-time thread. When an agent produces something (a doc, a table, a diagram), it becomes an **Artifact** on the canvas that everyone can see, edit, and comment on simultaneously with live multiplayer cursors.

**Nothing an agent does takes effect until every collaborator approves it.** Unanimity is the default, not an option you have to find.

> Plug your AI agent into a shared room, watch it work alongside your team's agents in real time, and ship nothing without everyone's yes.

## Status

Early. The full v1 surface is implemented and tested — boards, group chat, webhook and direct-model agents, doc + table artifacts, multiplayer cursors, unanimous consensus, link sharing — but it has not been deployed or run against real traffic. See [Known gaps](#known-gaps) before using it for anything that matters.

## How consensus works

Everything that changes shared reality goes through one pipeline:

```
intent → Proposal (staged) → votes collected live → resolved (applied | rejected | expired)
```

**Requires a proposal:** any agent-authored artifact create or patch, an agent prompting another agent, publishing an artifact, adding or removing an agent, changing the consensus policy, inviting an editor.

**Does not:** humans chatting, humans editing artifact bodies directly (that's ordinary CRDT collaboration), cursors, presence, adding a viewer.

The default policy is unanimous approval from all active members, where "active" means connected now or seen in the last 5 minutes. One rejection resolves immediately. A proposal that times out is **rejected, never auto-approved**. Changing the policy is itself a unanimous proposal, and the board header shows a persistent badge whenever the rule is not unanimous.

Two properties are worth calling out because they are what makes this trustworthy rather than decorative:

- **The server is authoritative.** Vote tallies live in the Yjs document so they animate live for everyone, but the resolution is computed server-side and written back. A client cannot resolve its own proposal.
- **Clients may only write their own vote.** The realtime document is a CRDT that every member can write to, so the server authorizes each write against the connection that made it. An attempt to write another member's vote — or to edit a proposal's status, payload, or expiry — is reverted before it is ever tallied. Without this, one member could forge a unanimous approval alone. See [`apps/ws/src/doc-guard.ts`](apps/ws/src/doc-guard.ts) and its tests.

Every resolution is appended to an immutable audit log in Postgres. Proposal and vote audit rows carry no foreign keys, so no cascade can delete them.

## Architecture

```
apps/
├─ web/          Next.js 15 (App Router) — the Board is the entire product
├─ ws/           Hocuspocus WebSocket server — realtime + authoritative consensus
└─ worker/       BullMQ consumers — agent turns, webhook delivery, retries
packages/
├─ shared/       Zod schemas, Yjs doc helpers, and the pure consensus engine
├─ agent-protocol/  the public Agent API contract + SDK (zero dependencies)
└─ db/           Drizzle schema, migrations, credential encryption
e2e/             Playwright multi-context collaboration tests
```

| Layer       | Choice                                                      |
| ----------- | ----------------------------------------------------------- |
| Framework   | Next.js 15 + React 19 + TypeScript (strict)                 |
| Styling     | Tailwind CSS v4 + hand-rolled Radix primitives              |
| Realtime    | Yjs (CRDT) + Hocuspocus, self-hosted                        |
| Persistence | PostgreSQL + Drizzle ORM                                    |
| Auth        | Auth.js — Google/GitHub OAuth, magic link, anonymous guests |
| Queue       | BullMQ on Redis                                             |
| Testing     | Vitest (unit), Playwright (multiplayer e2e)                 |

The consensus engine in `packages/shared/src/consensus/` is a pure function — `(proposal, votes, policy, activeMemberIds, now) => Resolution`. No I/O, no clock reads, no React. Both the web UI (to preview an outcome) and the ws server (to decide it) run the same code.

## Quick start

Requires **Node 20.9+** and **pnpm 9+**. Docker is the easiest way to get Postgres and Redis.

```bash
git clone git@github.com:muthanii/quorum.git
cd quorum
pnpm install
```

Start the local infrastructure:

```bash
docker compose up -d
```

Create your environment file and fill in the two required secrets:

```bash
cp .env.example .env
```

`AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` must both be 32 random bytes, base64-encoded. Generate each with:

```bash
openssl rand -base64 32
```

OAuth providers are optional — any provider whose variables are unset is simply skipped, and you can use anonymous guest sessions in development. Apply the database schema, then start everything:

```bash
pnpm db:migrate
```

```bash
pnpm dev
```

That runs web (`:3000`), ws (`:3001`), and the agent worker together. Open http://localhost:3000 and create a board.

## Connecting an agent

Two integration modes, both one paste and one click.

**Webhook agents (recommended).** You give Quorum an HTTPS URL. It POSTs a turn payload; you respond with messages and operations. Every request is signed with HMAC-SHA256 over `<timestamp>.<body>` in an `X-Quorum-Signature` header, and **your endpoint must verify it**.

Runnable starter agents live in [`packages/agent-protocol/snippets/`](packages/agent-protocol/snippets) for Node, Python, and curl. The Node one is a complete working agent in ~100 lines with no dependencies:

```bash
QUORUM_SIGNING_SECRET=whsec_yoursecret node packages/agent-protocol/snippets/node/agent-server.mjs
```

**Direct model agents.** Paste an OpenAI- or Anthropic-compatible base URL, API key, and model name, and Quorum runs the loop for you.

A turn looks like this:

```jsonc
POST <your endpoint>
X-Quorum-Signature: t=<unix>,v1=<hmac-sha256>
{
  "turnId": "trn_...",
  "boardId": "brd_...",
  "agent": { "id": "agt_...", "name": "Researcher" },
  "trigger": { "type": "mention" },
  "context": { "messages": [...], "artifacts": [...], "openProposals": [...] },
  "capabilities": ["message", "artifact.create", "artifact.patch", "proposal.create"]
}
```

And you reply:

```json
{
  "messages": [{ "content": "Here's a first pass at the brief." }],
  "operations": [{ "op": "artifact.create", "type": "doc", "title": "Q3 Brief", "content": "..." }]
}
```

**Every operation becomes a Proposal.** An agent can never mutate a board directly — operations are staged for the humans to vote on. Turns are idempotent on `turnId`, time out after 60s, and retry three times with exponential backoff before the agent is marked `degraded` with a visible pill in the roster.

The contract is versioned (`/v1/`) and `packages/agent-protocol` is dependency-free so you can vendor it outright.

## Security

- Agent credentials are AES-256-GCM encrypted at rest and never returned by any API — only a masked suffix like `…abc4`. The per-agent signing secret is shown exactly once, at connect time.
- Every outbound webhook is signed; verification is constant-time with a 300s timestamp tolerance.
- Agent endpoints are validated against an SSRF allowlist: HTTPS only, private/reserved/metadata IP ranges blocked (v4 and v6), DNS resolved and checked, redirects refused.
- Agent-produced markdown and HTML is sanitized with DOMPurify before render. Agent output is treated as hostile.
- WebSocket connections are authorized in the Hocuspocus `onAuthenticate` hook against a short-lived board-scoped JWT. A board id is not an authorization token.
- Secrets never enter the Yjs document — every board member can read the whole thing.

## Commands

```bash
pnpm dev            # web + ws + worker together
pnpm typecheck      # tsc --noEmit across the workspace
pnpm lint           # eslint + prettier
pnpm test           # vitest
pnpm test:e2e       # playwright multi-context collaboration tests
pnpm db:generate    # drizzle migration from schema
pnpm db:migrate
pnpm db:studio
pnpm analyze        # bundle size report
```

## Testing

395 unit and integration tests. The consensus engine carries the heaviest coverage — unanimous pass, single veto, timeout expiry at the exact boundary, member disconnect mid-vote, rejoin, vote-order independence, policy change during an open proposal — plus a suite that proves vote forgery is prevented by disabling the guard and confirming the attacks succeed without it.

Yjs convergence is tested by driving two documents concurrently and asserting they converge. The agent protocol has contract tests against a mock agent server covering timeouts, malformed responses, duplicate turn ids, oversized payloads, and SSRF attempts.

```bash
pnpm test
```

The Playwright suite needs the stack running (`docker compose up -d` and `pnpm dev`) and drives two browser contexts against one board to assert cursor visibility, live artifact sync, and that a proposal stays blocked until the second context approves.

## Known gaps

Being honest about what is not done:

- **No rate limiting.** `POST /api/boards` will mint a new guest identity and board on every unauthenticated request. This needs a Redis-backed limiter before any public deployment.
- **The e2e suite has never been executed.** It is written and typechecks, but has not been run against live services.
- **Never deployed.** No production environment has been stood up; the deploy targets in the stack table are intended, not proven.
- **Bundle headroom is thin.** The board route is 245KB first-load JS against a 250KB budget. Run `pnpm analyze` before adding client-side dependencies.
- **The Yjs update log grows unbounded.** Snapshots are written, but the append-only update log has no compaction yet.

## License

MIT — see [LICENSE](LICENSE).
