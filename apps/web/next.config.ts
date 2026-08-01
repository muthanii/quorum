import type { NextConfig } from "next";

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
