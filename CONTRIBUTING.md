# Contributing to Quorum

Thanks for looking. This file is the short version of everything you need to be
productive; if something here is wrong or missing, that is a bug worth reporting.

## Setup

Requires **Node 20.9+** (`.nvmrc` pins 22), **pnpm 9+**, and Docker for Postgres and Redis.

```bash
git clone git@github.com:muthanii/quorum.git && cd quorum
pnpm install
docker compose up -d
cp .env.example .env
```

`AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` each need 32 random bytes, base64:

```bash
openssl rand -base64 32
```

Then:

```bash
pnpm db:migrate && pnpm dev
```

`pnpm dev` runs web (`:3000`), ws (`:3001`), and the worker together. The root `.env` is
loaded for all three — web reads it in `next.config.ts`, ws and worker via `--env-file`.

## Before you push

```bash
pnpm typecheck && pnpm lint && pnpm test
```

CI runs exactly these plus a production build of `apps/web`. All four must pass.

## Running the e2e suite

The Playwright suite is **not** self-starting. Bring the stack up yourself first:

```bash
docker compose up -d
pnpm db:migrate
pnpm dev
```

then, in another shell:

```bash
pnpm test:e2e
```

Two things that will bite you otherwise:

- **It must be a dev build.** The consensus spec drives proposals through
  `apps/web/lib/yjs/e2e-hook.ts`, which is compiled out of production bundles.
- **Rate limiting will starve it.** The suite creates a board per spec across 4 workers,
  and `boards.create` is capped at 10/min per bucket. Locally there is no
  `x-forwarded-for` header, so every caller shares one bucket. `.env.example` ships
  `RATE_LIMIT_BOARDS_CREATE=200` for this reason — keep it set, or 8 of 18 specs fail
  with `429`.

The `presence-quorum` spec takes ~6 minutes on purpose: it waits out the real
disconnect grace period. A full run is about 6-7 minutes.

## Architecture rules that are not negotiable

These come from `CLAUDE.md` and reviewers will hold you to them:

- **Never bypass the consensus pipeline.** Every agent-authored mutation is a Proposal,
  including in tests and fixtures. The ws server is the only authority on resolution.
- **Anything both client and server must agree on lives in `packages/shared`.** Do not
  duplicate a type or a rule. (A cascade constant was once copy-pasted into two files
  with each comment claiming it matched the other; they had already drifted.)
- **Zod at every boundary** — API handlers, agent payloads, env vars.
- **Never log or echo agent credentials**, not even truncated, not even in dev.
- **`packages/agent-protocol` stays dependency-free** so users can vendor it.
- Ask before adding a dependency, changing the Y.Doc schema, changing the agent
  protocol, or adding a new top-level route.

## Tests

- New exported function in `packages/shared` or `lib/consensus` → unit test required.
- Bug fix → regression test that fails before the fix.
- New conditional → cover both branches.
- Test behaviour, not implementation. No snapshot tests of whole components.

Regression tests use a `*.regression-N.test.ts` suffix and carry an attribution comment
naming what broke.

## Commits and PRs

Conventional-commit prefixes (`fix:`, `feat:`, `test:`, `chore:`, `docs:`). One logical
change per commit. Explain _why_ in the body — the diff already shows what.

Open a PR against `main`. CI must be green.

## Reporting bugs

Use the issue templates. For anything security-related, do **not** open an issue — see
[SECURITY.md](SECURITY.md).
