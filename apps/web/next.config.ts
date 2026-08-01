import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

// The monorepo keeps ONE .env at the repo root (README quick start: `cp
// .env.example .env`), but Next resolves .env relative to this app directory,
// so nothing would load it and every route would 500 on lib/env.ts. Load it
// here — next.config is evaluated before any route compiles, and loadEnvFile
// never overwrites a variable the platform already set, so Vercel/Fly keep
// priority and the file is simply absent in production.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(rootEnv);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages export raw TypeScript source; Next transpiles them.
  transpilePackages: ["@quorum/shared", "@quorum/agent-protocol", "@quorum/db"],
};

export default async function config(): Promise<NextConfig> {
  if (process.env.ANALYZE === "true") {
    const { default: bundleAnalyzer } = await import("@next/bundle-analyzer");
    return bundleAnalyzer({ enabled: true })(nextConfig);
  }
  return nextConfig;
}
