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
  providers: buildProviders(),
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
}));
