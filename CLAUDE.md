# CLAUDE.md

Guidance for Claude Code when working in this repository.

---

## 1. What we're building

**Quorum** — a collaborative workspace for AI agents. Think **Google Sheets for AI agents**, wearing **Figma's** clothes, behaving like a **group chat**.

A team opens a shared Board. Each member plugs in their own AI agent via an API key or webhook. Everyone — humans and agents — talks in one real-time thread. When an agent produces something (a doc, a table, a diagram, code), it becomes an **Artifact** on the canvas that everyone can see, edit, and comment on simultaneously with live multiplayer cursors. **Nothing an agent does takes effect until every collaborator approves it.** Unanimity is the default, not an option you have to find.

### The one-sentence pitch
> Plug your AI agent into a shared room, watch it work alongside your team's agents in real time, and ship nothing without everyone's yes.

### Non-negotiable product principles

Every design and code decision is measured against these. If a change violates one, it is wrong even if it is technically elegant.

1. **Zero setup.** A new user reaches a working Board in under 60 seconds with no config files, no CLI, no infra. Paste a link, paste an API key, go.
2. **Everything is on screen.** No hidden menus, no settings pages you must discover, no modal mazes. If a feature can't be surfaced on the main canvas or a single side rail, question whether it should exist.
3. **Unanimous by default.** Prompts, agent actions, and artifact commits require approval from *all* active collaborators. Consensus rules can be relaxed per-board, never silently.
4. **Real time or it doesn't count.** Every mutation is visible to every connected peer in <150ms p95. No "refresh to see changes."
5. **Sharing is one click.** A link. That's the whole flow. Permissions are chosen inline, not in an admin panel.
6. **Lightweight.** Initial JS payload budget: **<250KB gzipped**. Cold TTI <2s on a mid-tier laptop over 4G. We are not building an IDE.

### Explicit non-goals
- Not an agent-building platform. We don't host, train, or fine-tune models. Users **bring their own agent**.
- Not a workflow/DAG builder (no n8n / Zapier node graphs).
- Not an enterprise admin console. No org charts, no SCIM in v1.
- Not offline-first. Real-time collaboration is the product.

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js 15 (App Router)** + React 19 + TypeScript (strict) | Server Components for shell, Client Components for canvas |
| Styling | **Tailwind CSS** + **shadcn/ui** (Radix primitives) | No CSS-in-JS. No ad-hoc `<style>` |
| Realtime state | **Yjs (CRDT)** + **Hocuspocus** WebSocket server | Self-hosted, no vendor lock-in |
| Presence / cursors | `y-protocols/awareness` | Ephemeral, never persisted |
| Persistence | **PostgreSQL** + **Drizzle ORM** | Yjs doc binaries stored as `bytea` snapshots + update log |
| Auth | **Auth.js (NextAuth)** — Google/GitHub OAuth + magic link | Anonymous guest sessions supported for shared links |
| Agent runtime | Node worker pool (`packages/agent-runner`) | Calls user-supplied endpoints; never executes user code |
| Queue | **BullMQ** on Redis | Agent turn scheduling, retries, timeouts |
| Validation | **Zod** everywhere at boundaries | API, env, agent payloads |
| Testing | **Vitest** (unit), **Playwright** (e2e + multiplayer) | |
| Package manager | **pnpm** workspaces | |
| Deploy | Vercel (web) + Fly.io (ws + workers) + Neon (pg) + Upstash (redis) | |

**Do not add a dependency without checking it against the 250KB budget.** Run `pnpm analyze` after any new client-side package.

---

## 3. Repo layout

```
quorum/
├─ apps/
│  ├─ web/                    # Next.js app
│  │  ├─ app/
│  │  │  ├─ (marketing)/      # landing, pricing
│  │  │  ├─ (app)/b/[boardId] # the Board — the entire product
│  │  │  └─ api/              # REST + webhook endpoints
│  │  ├─ components/
│  │  │  ├─ canvas/           # artifact surface, cursors, selection
│  │  │  ├─ chat/             # the group-chat rail
│  │  │  ├─ consensus/        # approval chips, vote bars, veto UI
│  │  │  ├─ agents/           # agent roster, connect flow, status pills
│  │  │  └─ ui/               # shadcn primitives (do not hand-edit)
│  │  └─ lib/
│  │     ├─ yjs/              # doc schema, providers, hooks
│  │     ├─ consensus/        # vote state machine (pure, testable)
│  │     └─ api/              # typed client
│  ├─ ws/                     # Hocuspocus server (auth hooks, persistence)
│  └─ worker/                 # BullMQ consumers: agent turns, webhooks
├─ packages/
│  ├─ shared/                 # Zod schemas + TS types shared everywhere
│  ├─ agent-protocol/         # the public Agent API contract + SDK
│  └─ db/                     # Drizzle schema + migrations
└─ e2e/                       # Playwright multi-context tests
```

**Rule:** anything that both the client and server need to agree on lives in `packages/shared`. Never duplicate a type.

---

## 4. Core domain model

```ts
Board       // the room. has members, agents, a Yjs doc, consensus policy
Member      // human user in a board (owner | editor | viewer)
Agent       // a connected AI agent, owned by a Member
Message     // group-chat entry: from a Member or an Agent
Proposal    // ANY mutation requiring consensus (see §6)
Artifact    // generated output living on the canvas
Vote        // a Member's approve/reject/abstain on a Proposal
```

### Yjs document shape (the single source of truth for live state)

```
Y.Doc
├─ "chat"       Y.Array<Message>       # append-only group chat
├─ "artifacts"  Y.Map<artifactId, Y.Map>
│                 ├─ meta   Y.Map      # type, title, position, size, authorAgentId
│                 └─ body   Y.Text | Y.XmlFragment | Y.Map   # per artifact type
├─ "proposals"  Y.Map<proposalId, Y.Map>   # open proposals + live vote tallies
└─ awareness (ephemeral)  { userId, name, color, cursor, selection, isTyping }
```

**Never** put durable business state only in Postgres if it must render live — it belongs in the Y.Doc. **Never** put secrets (agent API keys) in the Y.Doc — the whole doc is readable by every board member.

Postgres holds: identity, membership, billing, encrypted agent credentials, board metadata, doc snapshots, and an immutable audit log of proposals/votes.

---

## 5. The Agent API (our most important public surface)

Connecting an agent must take **one paste and one click**. Two integration modes:

**A. Webhook agents (default, recommended).** User gives us an HTTPS URL + optional bearer token. We POST a turn payload; they respond with messages/artifact ops.

**B. Direct model agents.** User pastes an OpenAI/Anthropic-compatible base URL + key + model name. We do the loop ourselves.

### Turn payload (we → agent)

```jsonc
POST <agent.endpoint>
X-Quorum-Signature: t=<unix>,v1=<hmac-sha256>   // ALWAYS sign. Agents must verify.
{
  "turnId": "trn_...",
  "boardId": "brd_...",
  "agent": { "id": "agt_...", "name": "Researcher" },
  "trigger": { "type": "mention" | "broadcast" | "proposal_approved" | "schedule" },
  "context": {
    "messages": [ { "role": "human"|"agent", "authorId": "...", "name": "...", "content": "..." } ],
    "artifacts": [ { "id": "art_...", "type": "doc", "title": "...", "content": "..." } ],
    "openProposals": [ /* ... */ ]
  },
  "capabilities": ["message", "artifact.create", "artifact.patch", "proposal.create"]
}
```

### Agent response (agent → us)

```jsonc
{
  "messages": [ { "content": "Here's a first pass at the brief." } ],
  "operations": [
    { "op": "artifact.create", "type": "doc", "title": "Q3 Brief", "content": "..." },
    { "op": "artifact.patch",  "artifactId": "art_...", "patch": [ /* JSON Patch */ ] }
  ]
}
```

### Hard rules for the Agent API
- **Every operation becomes a Proposal.** An agent can never mutate a board directly. `operations` are staged, not applied.
- **Idempotent on `turnId`.** Retries must not double-post.
- **Timeout 60s, 3 retries with exponential backoff**, then the agent is marked `degraded` in the roster with a visible pill.
- **Version the contract** (`/v1/`). Never break a shipped payload shape.
- Keep `packages/agent-protocol` dependency-free so users can vendor it.
- Ship copy-pasteable starter snippets (Node, Python, curl) alongside every contract change.

---

## 6. Consensus engine (the differentiator — get this exactly right)

Everything that changes shared reality goes through the same pipeline:

```
intent → Proposal (staged) → votes collected live → resolved (applied | rejected | expired)
```

### What requires a Proposal
- An agent posting a prompt to another agent
- Any `artifact.create` / `artifact.patch` from an agent
- Publishing / exporting an artifact
- Adding or removing an agent from the board
- Changing the board's consensus policy
- Inviting a member at `editor` or above

### What does NOT require a Proposal
- Humans chatting
- Humans editing artifact bodies directly (that's collaborative editing, CRDT-merged)
- Cursor movement, presence, reactions, comments
- Adding a `viewer`

### Default policy

```ts
{
  rule: "unanimous",        // all ACTIVE human members must approve
  quorum: "active",         // members connected OR seen in last 5 min
  timeoutMs: 5 * 60 * 1000, // then auto-expire (never auto-approve)
  onTimeout: "reject",
  vetoIsFinal: true,        // one reject resolves immediately
  autoApproveOwnProposals: false
}
```

Alternative rules (`majority`, `owner_only`, `threshold:N`) exist but **changing the policy is itself a unanimous proposal**, and the board header shows a persistent badge when the rule is not `unanimous`.

### Implementation rules
- `lib/consensus/` is a **pure state machine**: `(proposal, votes, policy, now) => Resolution`. No I/O, no React, no DB. Exhaustively unit-tested including races.
- Vote tallies live in the Y.Doc so they animate live for everyone. The **authoritative** resolution is computed server-side in the ws server and written back — never trust a client-computed resolution.
- Resolutions are **append-only and audited** to Postgres. Never delete a proposal record.
- Applying an approved proposal must be **atomic** against the Y.Doc — one transaction, or nothing.
- Handle the disconnect edge case explicitly: if a member drops mid-vote, they leave the active quorum after the grace period; the UI must *show* that recalculation happening, not silently change the threshold.

---

## 7. UI conventions

### Layout — a Board is one screen, three zones
```
┌──────────────────────────────────────────────────────────┐
│ header: board name · avatars+presence · Share · policy   │
├───────────────────────────────┬──────────────────────────┤
│                               │                          │
│   CANVAS                      │   CHAT RAIL              │
│   artifacts, multiplayer      │   group chat, humans +   │
│   cursors, selection halos    │   agents, inline vote    │
│                               │   chips on proposals     │
│                               │                          │
├───────────────────────────────┴──────────────────────────┤
│ composer: message · @mention agent · attach              │
└──────────────────────────────────────────────────────────┘
```
Agent roster is a collapsible strip in the header. **There is no settings page in the main flow.**

### Visual language (Figma-inspired)
- Dark-first, light supported. Neutral greys, one accent, per-user identity colors.
- **8px spacing grid.** Radii: 6px controls, 10px panels, 14px floating surfaces.
- Elevation via subtle borders + soft shadows, never heavy drop shadows.
- Typography: Inter (UI), JetBrains Mono (code/data). UI text 13–14px. Tight, dense, calm.
- Motion: 120–200ms, `cubic-bezier(0.2, 0, 0, 1)`. Cursors interpolate, never teleport. **Respect `prefers-reduced-motion`.**
- Every user gets a stable color from a fixed 12-color palette (deterministic hash of userId) used for cursor, avatar ring, selection halo, and vote chip. Same human = same color everywhere.

### Interaction rules
- Cursors carry a name label; labels fade after 2s of stillness.
- Selection is broadcast — you see what others have selected, haloed in their color.
- Pending proposals render as a **card in the chat rail + a dashed outline on the affected artifact** simultaneously. State is never in only one place.
- Vote chips are inline and one click. Approving must never open a modal.
- Optimistic UI for local edits; server reconciles. Rolled-back ops must be visibly explained, never silently reverted.
- Keyboard: `⌘K` command palette, `⌘Enter` send, `⌘/` toggle rail, `A`/`R` approve/reject when a proposal is focused.
- Empty states teach. A blank board shows the connect-an-agent card, not a shrug.

### Accessibility
WCAG 2.1 AA. All interactive elements keyboard-reachable, focus visible. Cursor color is never the *only* signal — always pair with a name or icon. Live regions announce new proposals.

---

## 8. Coding standards

- **TypeScript strict.** `any` is a review blocker; use `unknown` + a Zod parse.
- **Zod at every boundary** — API handlers, agent payloads, env vars (`lib/env.ts` fails fast at boot).
- **Server Components by default.** `"use client"` only for interactivity; push it as deep as possible.
- Data fetching: **TanStack Query** for REST; **Yjs hooks** for live state. Do not mirror Y.Doc state into `useState` — subscribe to it.
- Naming: components `PascalCase.tsx`, hooks `useThing.ts`, pure logic `kebab-case.ts`.
- Errors: never swallow. Surface a user-visible toast with a recovery action, and log structured JSON server-side.
- Comments explain **why**, never what. Delete dead code — git remembers.
- No barrel `index.ts` re-export files (they wreck tree-shaking).
- Every exported function in `packages/shared` and `lib/consensus` needs a unit test.

### Security
- Agent credentials are **encrypted at rest** (AES-256-GCM, key from env) and never returned by any API — only a masked suffix.
- **Sign every outbound webhook** with HMAC-SHA256 and a timestamp; document verification for users.
- Validate and allowlist agent endpoint URLs: HTTPS only, **block private IP ranges and metadata endpoints (SSRF)**.
- Sanitize all agent-produced HTML/markdown before render (DOMPurify). Assume agent output is hostile.
- Rate-limit per agent and per board.
- Authorize Yjs connections in the Hocuspocus `onAuthenticate` hook — a board id is not an authorization token.

---

## 9. Commands

```bash
pnpm dev            # web + ws + worker together
pnpm dev:web        # Next.js only
pnpm build
pnpm typecheck      # tsc --noEmit across the workspace  ← run before every commit
pnpm lint           # eslint + prettier check
pnpm test           # vitest
pnpm test:e2e       # playwright, incl. multi-browser-context collab tests
pnpm db:generate    # drizzle migration from schema
pnpm db:migrate
pnpm db:studio
pnpm analyze        # bundle size report — check against the 250KB budget
```

**Before declaring any task complete: `pnpm typecheck && pnpm lint && pnpm test`.**

---

## 10. Testing expectations

- **Consensus engine:** exhaustive unit tests. Cover unanimous pass, single veto, timeout expiry, member disconnect mid-vote, member rejoin, concurrent votes, policy change during an open proposal.
- **Yjs merges:** simulate two clients editing the same artifact concurrently; assert convergence.
- **Multiplayer e2e:** Playwright with ≥2 browser contexts. Assert cursor visibility, live artifact sync, and that a proposal is blocked until the second context approves.
- **Agent protocol:** contract tests against a mock agent server — timeout, malformed response, duplicate `turnId`, oversized payload, SSRF attempt.
- Test behavior, not implementation. No snapshot tests of whole components.

---

## 11. Working agreements for Claude

- **Read before you write.** Check existing patterns in neighboring files; match them.
- **Prefer the smallest change that works.** This codebase should stay small enough to hold in your head.
- When a request conflicts with a principle in §1, **say so and propose an alternative** rather than silently implementing it.
- **Never bypass the consensus pipeline** for convenience, even in a prototype or a test fixture helper. It is the product.
- **Never log or echo agent credentials**, not even truncated, not even in dev.
- Ask before: adding a dependency, changing the Y.Doc schema, changing the agent protocol, or adding a new top-level route.
- Y.Doc schema changes need a migration path — live docs exist in the wild and cannot be recreated.
- Don't create README/docs files unless asked. Don't commit unless asked.

---

## 12. Roadmap markers

**v1 (now):** boards, group chat, webhook agents, doc + table artifacts, multiplayer cursors, unanimous consensus, link sharing.

**Later:** artifact version history w/ diff, threaded comments, scheduled agent turns, agent marketplace/templates, board templates, MCP-native agent connection, SSO.

**Deliberately deferred:** offline mode, mobile-native apps, self-hosting, granular per-artifact permissions.
