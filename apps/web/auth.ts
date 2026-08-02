/**
 * Auth.js v5 configuration. Providers are conditional on env presence — in a
 * bare dev setup with no OAuth keys the app still boots and guests still
 * work (zero-setup principle). Database sessions via the Drizzle adapter on
 * @quorum/db.
 */
import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";

import { getDb } from "@quorum/db/client";
import { accounts, sessions, users, verificationTokens } from "@quorum/db/schema";

import { env } from "@/lib/env";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

function buildProviders(): NextAuthConfig["providers"] {
  const providers: NextAuthConfig["providers"] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    providers.push(Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET }));
  }
  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) {
    providers.push(GitHub({ clientId: env.AUTH_GITHUB_ID, clientSecret: env.AUTH_GITHUB_SECRET }));
  }
  if (env.AUTH_RESEND_KEY && env.EMAIL_FROM) {
    providers.push(Resend({ apiKey: env.AUTH_RESEND_KEY, from: env.EMAIL_FROM }));
  }
  return providers;
}

/** What /signin renders a button for. Empty in a bare setup — see below. */
export interface ConfiguredProvider {
  id: string;
  name: string;
}

/**
 * The providers actually wired up, derived from the SAME list Auth.js gets so
 * the two can never disagree.
 *
 * Callers use this to decide whether signing in is possible at all: with no
 * OAuth keys the list is empty, and anything that offers a sign-in affordance
 * would otherwise send people to a page that cannot sign them in.
 */
export function configuredProviders(): ConfiguredProvider[] {
  return buildProviders().map((provider) => {
    const config = typeof provider === "function" ? provider() : provider;
    return { id: config.id, name: config.name };
  });
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  // Lazy config: getDb() is called per request, not at import, so importing
  // this module never opens a database connection by itself.
  // The adapter ships against a newer @auth/core than next-auth beta bundles;
  // the Adapter shape is structurally identical, hence the cast.
  adapter: DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }) as Adapter,
  session: { strategy: "database" },
  secret: env.AUTH_SECRET,
  trustHost: true,
  // Auth.js's built-in page renders an empty card when no provider is
  // configured, which is the documented default here — a dead end in the
  // product's own light theme. Ours explains itself and always offers a way on.
  pages: { signIn: "/signin", error: "/signin" },
  providers: buildProviders(),
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
}));
