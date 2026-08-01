/**
 * Guest sessions (build brief "Web app conventions"): a signed httpOnly
 * cookie `quorum_guest` carrying a jose HS256 JWT `{ sub: "usr_…", name }`,
 * minted on first visit to an invite link (or first anonymous board create).
 *
 * This module is pure token logic — no next/headers, no env — so it is unit
 * testable. Reading/writing the actual cookie happens in lib/auth/viewer.ts
 * and the route handlers, which own the request context.
 */
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";

import { idSchema } from "@quorum/shared/ids";

export const GUEST_COOKIE = "quorum_guest";

/** Guests stay signed in for 30 days; membership rows outlive the cookie. */
export const GUEST_SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export const guestClaimsSchema = z.object({
  /** Guests get a real usr_ row so memberships/FKs work identically. */
  sub: idSchema("user"),
  name: z.string().min(1).max(80),
});

export type GuestClaims = z.infer<typeof guestClaimsSchema>;

const encoder = new TextEncoder();

export async function signGuestToken(
  claims: GuestClaims,
  secret: string,
  options?: { expiresAt?: Date },
): Promise<string> {
  const expiresAt = options?.expiresAt ?? new Date(Date.now() + GUEST_SESSION_MAX_AGE_SEC * 1000);
  return new SignJWT({ name: claims.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(encoder.encode(secret));
}

/**
 * Verify a guest token. Returns null for anything invalid — bad signature,
 * expired, malformed claims. Null is a domain result ("no guest session"),
 * not a swallowed error: an unauthenticated visitor is a normal state.
 */
export async function verifyGuestToken(token: string, secret: string): Promise<GuestClaims | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), { algorithms: ["HS256"] });
    const parsed = guestClaimsSchema.safeParse({ sub: payload.sub, name: payload.name });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface GuestCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

export function guestCookieOptions(): GuestCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_SESSION_MAX_AGE_SEC,
  };
}
