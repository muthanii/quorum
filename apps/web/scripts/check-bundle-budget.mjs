#!/usr/bin/env node
/**
 * Enforce the initial-JS budget from CLAUDE.md §1: <250KB gzipped.
 *
 * Reads the route table Next prints at the end of `next build` and fails if any
 * route's First Load JS exceeds the budget. Next's reported figures are
 * gzipped (verified: a chunk reported as 54.2 kB measures 53.0 KB under gzip
 * and 169 KB raw), so they compare directly against the budget with no
 * conversion.
 *
 * Parsing Next's own output rather than recomputing from .next/ is deliberate:
 * the number the team reads in CI is then exactly the number being enforced,
 * and there is no second implementation of "which chunks count" to drift.
 *
 * Usage:  next build | tee build.log && node scripts/check-bundle-budget.mjs build.log
 */
import { readFileSync } from "node:fs";

const BUDGET_KB = 250;

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: check-bundle-budget.mjs <build-output.log>");
  process.exit(2);
}

const text = readFileSync(logPath, "utf8");

/** "245 kB" / "1.2 MB" / "149 B" → KB. */
function toKb(value, unit) {
  const n = Number(value);
  if (unit === "B") return n / 1024;
  if (unit === "kB") return n;
  if (unit === "MB") return n * 1024;
  return Number.NaN;
}

// Route rows look like:  ├ ƒ /b/[boardId]      107 kB      245 kB
// The LAST size on the row is First Load JS; the first is the route's own JS.
const ROUTE_ROW = /^[┌├└]\s+[^\s]*\s*(\/\S*)\s+.*?([\d.]+)\s*(B|kB|MB)\s*$/;

const routes = [];
for (const line of text.split("\n")) {
  const match = ROUTE_ROW.exec(line.trimEnd());
  if (match) routes.push({ route: match[1], firstLoadKb: toKb(match[2], match[3]) });
}

if (routes.length === 0) {
  console.error(
    "check-bundle-budget: found no route rows in the build output.\n" +
      "Did the build succeed, and was its stdout captured to the file passed in?",
  );
  process.exit(2);
}

const over = routes.filter((r) => r.firstLoadKb > BUDGET_KB);
const worst = routes.reduce((a, b) => (b.firstLoadKb > a.firstLoadKb ? b : a));

for (const { route, firstLoadKb } of over) {
  console.error(`OVER BUDGET  ${route}  ${firstLoadKb.toFixed(1)} kB > ${BUDGET_KB} kB gzipped`);
}

if (over.length > 0) {
  console.error(
    `\n${over.length} route(s) exceed the ${BUDGET_KB}KB initial-JS budget (CLAUDE.md §1).\n` +
      "Run `pnpm analyze` to see what landed in the bundle.",
  );
  process.exit(1);
}

const headroom = BUDGET_KB - worst.firstLoadKb;
console.log(
  `bundle budget OK — ${routes.length} routes, worst is ${worst.route} at ` +
    `${worst.firstLoadKb.toFixed(1)} kB gzipped (${headroom.toFixed(1)} kB headroom).`,
);
if (headroom < 15) {
  console.log(
    `NOTE: under 15 kB of headroom. Check \`pnpm analyze\` before adding a client dependency.`,
  );
}
