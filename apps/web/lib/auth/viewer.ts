/**
 * Who is looking at the app right now: an Auth.js session user, a guest with
 * a signed `quorum_guest` cookie, or nobody. Every server-side entry point
 * (pages, route handlers) resolves access through this single helper.
 */
import { cookies } from "next/headers";

import { auth } from "@/auth";
import { env } from "@/lib/env";
import { GUEST_COOKIE, verifyGuestToken } from "./guest";

export interface Viewer {
  /** usr_… — guests get a real users row too, so this is always a user id. */
  id: string;
  name: string;
  kind: "user" | "guest";
}

export async function resolveViewer(): Promise<Viewer | null> {
  const session = await auth();
  const sessionUser = session?.user;
  if (sessionUser?.id) {
    return {
      id: sessionUser.id,
      name: sessionUser.name ?? sessionUser.email ?? "Member",
      kind: "user",
    };
  }

  const cookieStore = await cookies();
  const raw = cookieStore.get(GUEST_COOKIE)?.value;
  if (!raw) return null;
  const claims = await verifyGuestToken(raw, env.AUTH_SECRET);
  if (!claims) return null;
  return { id: claims.sub, name: claims.name, kind: "guest" };
}
