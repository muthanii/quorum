/**
 * Guest identity: guests get a REAL users row (usr_…) so memberships, board
 * ownership, and audit ids work identically to signed-in users. The only
 * difference is how the session is carried (quorum_guest cookie vs Auth.js).
 */
import { getDb } from "@quorum/db/client";
import { users } from "@quorum/db/schema";
import { newId } from "@quorum/shared/ids";

import { signGuestToken } from "@/lib/auth/guest";
import { env } from "@/lib/env";

export interface GuestIdentity {
  id: string;
  name: string;
  /** Signed quorum_guest JWT — set it on the response with guestCookieOptions(). */
  token: string;
}

export async function createGuest(): Promise<GuestIdentity> {
  // Mint the id up front so the human-tellable name can derive from it in a
  // single insert.
  const id = newId("user");
  const name = `Guest ${id.slice(-4)}`;
  const db = getDb();
  await db.insert(users).values({ id, name });
  const token = await signGuestToken({ sub: id, name }, env.AUTH_SECRET);
  return { id, name, token };
}
