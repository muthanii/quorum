# Deploying Quorum

The honest runbook. Everything here is run by a human with their own credentials — nothing in this repo deploys itself.

Read [Known gaps](#known-gaps) before you promise anyone an SLA.

---

## 1. Topology

| Service       | Runs on     | What it is                                                             |
| ------------- | ----------- | ---------------------------------------------------------------------- |
| `apps/web`    | **Vercel**  | Next.js 15 app — marketing, board shell, REST API, Auth.js             |
| `apps/ws`     | **Fly.io**  | Hocuspocus websocket server + internal HTTP API on one port            |
| `apps/worker` | **Fly.io**  | BullMQ consumer — calls agent endpoints, posts results back to `ws`    |
| Postgres      | **Neon**    | identity, membership, encrypted agent creds, snapshots, proposal audit |
| Redis         | **Upstash** | BullMQ queue + API rate limiting                                       |

```
                 wss://          ┌──────────────┐
  browser ──────────────────────▶│  apps/ws     │◀── internal HTTP ──┐
     │                            │  (Fly, x1)   │                    │
     │ https://                   └──┬────────┬──┘                    │
     ▼                               │        │                       │
┌──────────┐   enqueue turn          │        │                ┌──────────────┐
│ apps/web │──────────────────────────┘        │                │ apps/worker  │
│ (Vercel) │                                   │                │ (Fly, x1..n) │
└────┬─────┘                                   │                └──────┬───────┘
     │                    ┌────────────────────┴──────────┐            │
     └───────────────────▶│  Neon (pg)  ·  Upstash (redis)│◀───────────┘
                          └───────────────────────────────┘
```

### Why `apps/ws` cannot go on Vercel

A Vercel function is pinned to a single invocation and a single instance. Two things break:

1. **A websocket outlives the invocation.** Vercel functions have no long-lived process to hold the connection open across a board session.
2. **Even if they did, the next connection is not guaranteed to land on the same instance.** A board's `Y.Doc` lives in the ws process's memory. If Alice's socket lands on instance A and Bob's on instance B, they are editing two different copies of the same board. Their cursors do not appear to each other, their artifact edits do not merge, and — the part that actually matters — the two instances compute two independent vote tallies. A proposal can be "unanimously approved" on one instance while still open on the other. Consensus fails **silently**: nothing errors, the UI looks fine, and the board is wrong.

The same reasoning is why the ws app runs **exactly one Fly machine** (`auto_stop_machines = false`, `strategy = "immediate"`, `fly scale count 1`). There is no Hocuspocus Redis extension wired up, so horizontal scaling would reintroduce the split-doc problem inside Fly. Scale the ws server **up** (bigger VM), never **out**, until doc state is shared.

`apps/worker` is on Fly for a duller reason: a BullMQ consumer is a process that runs forever and blocks on Redis. There is no request to hang it off.

---

## 2. Blocker: the worker cannot reach the ws server yet

**Read this before step 5. As written, a split deploy will look healthy and quietly do nothing.**

`apps/worker/src/env.ts` hard-codes the ws internal API base URL:

```ts
wsInternalBaseUrl: `http://localhost:${parsed.data.WS_PORT}`,
```

That is correct for `pnpm dev` (one machine, both processes) and wrong for Fly, where `apps/ws` and `apps/worker` are separate apps on separate machines. Every `POST /internal/agent-result` and `POST /internal/agent-status` will fail with `ECONNREFUSED`. The visible symptom is the worst kind: turn jobs run, agents get called, and **nothing ever appears on the board** — no messages, no staged proposals, and the roster pill never leaves `working`. The worker log shows `turn job failed` with a network error and, after 3 attempts, marks the agent degraded (which also fails, for the same reason).

This config-only task did not patch it. The fix is small and belongs in a code change:

- Add an optional `WS_INTERNAL_URL` to `apps/worker/src/env.ts`, defaulting to `http://localhost:${WS_PORT}` so dev is untouched.
- Set it on Fly to the ws app's private address: `fly secrets set -a quorum-worker WS_INTERNAL_URL=http://quorum-ws.internal:3001`.

Use Fly's private `.internal` network rather than the public hostname: `/internal/*` is bearer-authenticated but there is no reason to expose it to the internet as well.

Until that lands, the only working deployment is one where the worker shares a machine with the ws server.

---

## 3. Environment variables

Three secrets **must be byte-identical across services** or the failure is silent-ish and confusing:

| Secret                       | Shared by    | What breaks if they differ                                                                    |
| ---------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                | web ↔ ws     | web mints the board websocket JWT, ws verifies it — every board hangs at "Connecting…"        |
| `INTERNAL_API_SECRET`        | ws ↔ worker  | ws returns `401` to the worker; agent results never reach the doc                             |
| `CREDENTIALS_ENCRYPTION_KEY` | web ↔ worker | web encrypts agent credentials, worker decrypts them — every agent turn fails to authenticate |

`DATABASE_URL` and `REDIS_URL` must point at the **same** Neon database and the **same** Upstash instance from all three services.

### `apps/web` (Vercel)

| Variable                     | Required | Notes                                                                         |
| ---------------------------- | -------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`               | **yes**  | Neon **pooled** connection string. `@quorum/db` sets `prepare: false` for it. |
| `REDIS_URL`                  | **yes**  | Must parse as a URL — Upstash `rediss://…`                                    |
| `AUTH_SECRET`                | **yes**  | ≥16 chars. Shared with ws.                                                    |
| `CREDENTIALS_ENCRYPTION_KEY` | **yes**  | base64 of exactly 32 bytes. Shared with worker.                               |
| `NEXT_PUBLIC_APP_URL`        | **yes**  | ⚠️ build time. `https://your-app.vercel.app`                                  |
| `NEXT_PUBLIC_WS_URL`         | **yes**  | ⚠️ build time. `wss://quorum-ws.fly.dev` — see §4.                            |
| `INTERNAL_API_SECRET`        | optional | Declared but unused by web in v1. Set it anyway so it does not drift.         |
| `AUTH_GOOGLE_ID` / `_SECRET` | optional | Provider is skipped unless **both** are set                                   |
| `AUTH_GITHUB_ID` / `_SECRET` | optional | Provider is skipped unless **both** are set                                   |
| `AUTH_RESEND_KEY`            | optional | Magic link. Needs `EMAIL_FROM` too.                                           |
| `EMAIL_FROM`                 | optional | Required only if `AUTH_RESEND_KEY` is set                                     |

`auth.ts` sets `trustHost: true`, so no `AUTH_URL` / `NEXTAUTH_URL` is needed. Do register `https://<your-domain>/api/auth/callback/{google,github}` with each OAuth provider.

Empty string counts as unset for every optional key (`lib/env.ts` preprocesses `""` → `undefined`), so a half-filled Vercel dashboard will not wedge the boot.

### `apps/ws` (Fly, app `quorum-ws`)

| Variable              | Required | Notes                                         |
| --------------------- | -------- | --------------------------------------------- |
| `DATABASE_URL`        | **yes**  | Same Neon database as web                     |
| `REDIS_URL`           | **yes**  | Same Upstash instance as web/worker           |
| `AUTH_SECRET`         | **yes**  | Must equal web's                              |
| `INTERNAL_API_SECRET` | **yes**  | Must equal worker's                           |
| `WS_PORT`             | no       | Defaults to `3001`; set in `fly.toml` `[env]` |

`CREDENTIALS_ENCRYPTION_KEY` is deliberately **not** here — ws never touches agent credentials.

### `apps/worker` (Fly, app `quorum-worker`)

| Variable                     | Required | Notes                                         |
| ---------------------------- | -------- | --------------------------------------------- |
| `DATABASE_URL`               | **yes**  | Must parse as a URL. Same Neon database.      |
| `REDIS_URL`                  | **yes**  | Must parse as a URL. Same Upstash instance.   |
| `INTERNAL_API_SECRET`        | **yes**  | Must equal ws's                               |
| `CREDENTIALS_ENCRYPTION_KEY` | **yes**  | base64 of exactly 32 bytes. Must equal web's. |
| `WS_PORT`                    | no       | Defaults to `3001`. See the blocker in §2.    |

### Generating the secrets

Generate each **once**, then paste the same value everywhere it is shared.

```bash
# AUTH_SECRET — web + ws
openssl rand -base64 32

# CREDENTIALS_ENCRYPTION_KEY — web + worker
# Must decode to exactly 32 bytes; base64 of 32 random bytes does.
openssl rand -base64 32

# INTERNAL_API_SECRET — ws + worker
openssl rand -hex 32
```

On Fly use `fly secrets set` (encrypted at rest, injected as env, triggers a redeploy) — never `[env]` in `fly.toml`. On Vercel add them as Environment Variables in the project settings, scoped to Production (and Preview if you want previews to work).

---

## 4. `NEXT_PUBLIC_WS_URL` is baked in at build time

**This is the single most likely thing to get wrong.**

Next.js inlines every `NEXT_PUBLIC_*` variable into the JavaScript bundle during `next build`. It is a string literal in the shipped code, not something read at runtime. Consequences:

- `NEXT_PUBLIC_WS_URL` **must be set in Vercel before the web build runs.** Setting it afterwards changes nothing until you **redeploy**. A "Redeploy" that reuses the existing build cache is not enough — trigger a fresh build.
- This is why `ws` is deployed **before** `web`: you need the Fly hostname to exist before the web build can bake it in.
- Same rule for `NEXT_PUBLIC_APP_URL`.

It must be a real `wss://` host. `apps/web/lib/yjs/provider.ts` has a fallback that follows the page's own hostname, but it only fires when the **configured** host is loopback (`localhost` / `127.0.0.1`) — that exists so a phone on the LAN can reach a dev machine. In production the configured host is not loopback, so the fallback never runs and whatever you baked in is what every browser dials. Get it right or the board sits at "Connecting…".

Use `wss://`, not `ws://`: the page is served over HTTPS and browsers block mixed-content websockets.

---

## 5. Order of operations

The order is not arbitrary — each step produces a value the next one needs.

**0. Land the worker→ws URL fix from §2.** Otherwise stop after step 4; agents will not work.

**1. Provision Neon.** Create the project and database. Copy both connection strings:

- the **pooled** one → `DATABASE_URL` for web / ws / worker
- the **direct** (unpooled) one → migrations only

**2. Provision Upstash.** Create a Redis database in the same region as the Fly apps. Copy the **TCP** endpoint (`rediss://default:<password>@<host>:6379`), not the REST URL — `ioredis` speaks the wire protocol.

**3. Run the migrations.** From the repo root:

```bash
DATABASE_URL='postgres://…direct…' pnpm db:migrate
```

`packages/db/drizzle.config.ts` reads `DATABASE_URL` straight off `process.env` and there is no `.env` in `packages/db`, so pass it inline. Use the **direct** endpoint — DDL through a transaction-mode pooler is unreliable.

**4. Generate the three shared secrets** (§3). Keep them somewhere you can paste from three times.

**5. Deploy `ws`.** From the repo root:

```bash
fly apps create quorum-ws
fly secrets set -a quorum-ws \
  DATABASE_URL='…' REDIS_URL='…' AUTH_SECRET='…' INTERNAL_API_SECRET='…'
fly deploy --config apps/ws/fly.toml --dockerfile apps/ws/Dockerfile .
fly scale count 1 -a quorum-ws   # exactly one — see §1
```

Note the trailing `.`: the build context is the repo root, because the image needs `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `packages/*`.

Write down the hostname (`quorum-ws.fly.dev`). You need it in step 7.

**6. Deploy `worker`.** From the repo root:

```bash
fly apps create quorum-worker
fly secrets set -a quorum-worker \
  DATABASE_URL='…' REDIS_URL='…' INTERNAL_API_SECRET='…' CREDENTIALS_ENCRYPTION_KEY='…' \
  WS_INTERNAL_URL='http://quorum-ws.internal:3001'   # once §2 has landed
fly deploy --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile .
```

**7. Deploy `web`.** In the Vercel project:

- Leave **Root Directory** at the repo root. `/vercel.json` lives there and drives the pnpm workspace build (`pnpm install --frozen-lockfile` at the root, `pnpm --filter @quorum/web build`, output at `apps/web/.next`). If you instead set Root Directory to `apps/web`, Vercel will read a `vercel.json` from `apps/web` and this one is ignored.
- Set the Node.js version to **22** (Vercel reads `engines.node`, not `.nvmrc`).
- Add every variable from the web table in §3 — **including `NEXT_PUBLIC_WS_URL=wss://quorum-ws.fly.dev`** — _before_ triggering the first build.
- Deploy.

Vercel picks up pnpm 9.15.4 automatically from the root `packageManager` field.

---

## 6. Verify it worked

Run these in order. Each one isolates a different link in the chain.

```bash
# 1. ws is up and serving the unauthenticated health route
curl -sS https://quorum-ws.fly.dev/healthz
# → {"ok":true}

# 2. ws booted cleanly (env parsed, pg + redis reachable)
fly logs -a quorum-ws | grep 'ws server listening'
# → {"level":"info","msg":"ws server listening","port":3001,"queue":"agent-turns"}

# 3. the internal API is actually locked down
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://quorum-ws.fly.dev/internal/agent-status
# → 401

# 4. worker booted and attached to the queue
fly logs -a quorum-worker | grep 'worker started'
# → {"level":"info","msg":"worker started","queue":"agent-turns","concurrency":5,…}
```

Then, in a browser:

5. Load `https://<your-domain>` — the marketing page renders. (If web's env is wrong this 500s at boot with a list of the offending variable **names**; values are never printed.)
6. Sign in, or continue as a guest.
7. Create a board. Open DevTools → Network → WS and confirm the socket connects to your Fly host, not `localhost`. If you see `localhost` here, `NEXT_PUBLIC_WS_URL` was set after the build — go back to §4.
8. Open the same board URL in a second browser context. Both avatars appear in the header; moving the mouse in one shows a live cursor in the other.
9. **Open a board and confirm the badge in the header reads `Live`.** That is the whole check — the badge is driven by the provider's connection status, so `Live` means the browser reached the Fly ws server, the JWT verified against a matching `AUTH_SECRET`, and the doc loaded from Neon.

---

## Known gaps

Things a reader would want to know and would not find out from the config.

- **The worker cannot reach the ws server across machines.** See §2. This is a real blocker for the documented topology, not a nice-to-have.
- **The e2e suite has never been run against a deployment.** `e2e/playwright.config.ts` hard-codes `baseURL: http://localhost:3000` and expects `docker compose` + `pnpm dev`. Worse, the consensus spec drives proposals through `apps/web/lib/yjs/e2e-hook.ts`, which is compiled out of production bundles — so that spec _structurally cannot_ pass against Vercel. Nothing in this runbook is covered by an automated test. Treat §6 as the real test suite.
- **The Yjs update log has no compaction.** `apps/ws/src/persistence.ts` appends every incremental update to `yjs_updates` forever and replays the _entire_ log on top of the latest snapshot on every cold document load. Nothing ever deletes rows below the snapshot watermark. A busy board gets slower to open and the Neon table grows without bound. Budget for a compaction job (delete `yjs_updates` rows at or below the newest `yjs_snapshots.seq`) before real usage.
- **`ws` is a single point of failure with no horizontal story.** One machine, by design (§1). A deploy or a crash disconnects every board; clients reconnect and Yjs re-syncs, but in-flight awareness is lost. Sharing doc state across instances needs `@hocuspocus/extension-redis`, which is not installed.
- **`strategy = "immediate"` means a visible reconnect on every ws deploy.** That is the deliberate trade against two concurrent ws instances. Deploy ws when boards are quiet.
- **BullMQ is chatty against a metered Redis.** Upstash bills per command and BullMQ polls. Watch the command count on the free tier before assuming the cost model holds.
- **No observability is wired up.** Both Fly apps log structured JSON to stdout and that is all. No error tracking, no alerting, no dashboards — nobody is paged when the worker starts failing turns.
- **Rate limits are per-instance-agnostic but Redis-backed** (`apps/ws/src/rate-limit.ts`, `apps/web/lib/server/rate-limit.ts`), so they survive the Vercel/Fly split correctly. They have not been load-tested.
