import { defineConfig } from "@playwright/test";

/**
 * Quorum multiplayer e2e suite (CLAUDE.md §10) — every spec drives TWO
 * browser contexts on one board.
 *
 * PREREQUISITES — this config deliberately does NOT auto-start services
 * (no `webServer` docker orchestration); bring the stack up yourself:
 *
 *   1. Infra:      docker compose up -d            (postgres :5432, redis :6379)
 *   2. Env:        cp .env.example .env            then set AUTH_SECRET,
 *                  CREDENTIALS_ENCRYPTION_KEY (openssl rand -base64 32 each)
 *                  and INTERNAL_API_SECRET (openssl rand -hex 32).
 *   3. Schema:     pnpm db:migrate                 (drizzle migrations)
 *   4. App:        pnpm dev                        (web :3000 + ws :3001 + worker)
 *
 * Seeding: none. Tests are self-seeding — each spec creates a fresh board as
 * an anonymous guest via POST /api/boards (guests get a real users row), so
 * runs never share state and no fixtures need loading.
 *
 * The web app must run a DEV build (`pnpm dev`): the consensus spec stages
 * proposals through the dev-only window hook (apps/web/lib/yjs/e2e-hook.ts),
 * which is compiled out of production bundles.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: 1,
  /* Live-sync assertions get explicit tight timeouts in the specs (e.g. the
     <2s artifact sync budget); this is the ceiling for everything else. */
  expect: { timeout: 10_000 },
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
});
