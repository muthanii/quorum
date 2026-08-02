<!--
Explain why, not what — the diff already shows what. If this fixes an issue,
put "Fixes #123" somewhere in the body.
-->

## What changed and why

## How it was verified

<!-- Commands you ran, what you clicked, what you measured. "Tests pass" alone is thin. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` all pass
- [ ] `pnpm test:e2e` passes, or this change cannot affect it
- [ ] New exported function in `packages/shared` or `lib/consensus` has a unit test
- [ ] Bug fix has a regression test that fails without the fix
- [ ] No agent credential is logged, echoed, or returned anywhere
- [ ] No change bypasses the consensus pipeline

## Needs a maintainer's sign-off before merge

<!-- Tick anything that applies. Each of these is an "ask first" item in CLAUDE.md. -->

- [ ] Adds a dependency
- [ ] Changes the Y.Doc schema (live docs exist and cannot be recreated)
- [ ] Changes the agent protocol (`packages/agent-protocol`)
- [ ] Adds a new top-level route
- [ ] Changes anything in the consensus engine or `doc-guard`
