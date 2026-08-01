/**
 * Board websocket authentication. The web app mints a short-lived JWT (jose,
 * HS256, AUTH_SECRET) with claims { sub, boardId, role, name, color }; the
 * client passes it as the Hocuspocus provider token and we verify it here in
 * onAuthenticate. A board id is not an authorization token — a valid JWT for
 * a *different* board is rejected.
 */
import { jwtVerify } from "jose";
import { z } from "zod";

import { PREFIXES, idSchema, isId } from "@quorum/shared/ids";
import { memberRoleSchema, type MemberRole } from "@quorum/shared/schemas/member";

const claimsSchema = z.object({
  sub: z.string().min(1),
  boardId: idSchema("board"),
  role: memberRoleSchema,
  name: z.string().min(1).max(80),
  color: z.string().min(1).max(32),
});

export interface BoardConnectionContext {
  userId: string;
  /** Derived board-member id (mem_…) — absent when sub is not a usr_ id. */
  memberId?: string;
  boardId: string;
  role: MemberRole;
  name: string;
  color: string;
  /** Viewers can watch everything but write nothing. */
  readOnly: boolean;
}

/**
 * Deterministic usr_ → mem_ mapping (build brief addendum #3). board_members
 * has no id column, so the member id is the user id's 16-char body under the
 * mem_ prefix — every process (web vote keys, ws engine input) derives the
 * same id with no lookup. Guests get usr_ ids too, so this covers them.
 */
export function memberIdForUser(userId: string): string | undefined {
  if (!isId("user", userId)) return undefined;
  return `${PREFIXES.member}${userId.slice(PREFIXES.user.length)}`;
}

export interface VerifyBoardTokenInput {
  token: string;
  /** The Hocuspocus document name — the board id the client is opening. */
  boardId: string;
  secret: string;
  /** Unix epoch ms clock for expiry checks — injectable for tests. */
  now?: number;
}

/**
 * Verify a board token and build the connection context. Throws on a bad
 * signature, expiry, malformed claims, or a token minted for another board.
 */
export async function verifyBoardToken(
  input: VerifyBoardTokenInput,
): Promise<BoardConnectionContext> {
  const key = new TextEncoder().encode(input.secret);
  const { payload } = await jwtVerify(input.token, key, {
    algorithms: ["HS256"],
    ...(input.now !== undefined ? { currentDate: new Date(input.now) } : {}),
  });

  const claims = claimsSchema.parse(payload);
  if (claims.boardId !== input.boardId) {
    throw new Error("token was issued for a different board");
  }

  const memberId = memberIdForUser(claims.sub);
  return {
    userId: claims.sub,
    ...(memberId !== undefined ? { memberId } : {}),
    boardId: claims.boardId,
    role: claims.role,
    name: claims.name,
    color: claims.color,
    readOnly: claims.role === "viewer",
  };
}
