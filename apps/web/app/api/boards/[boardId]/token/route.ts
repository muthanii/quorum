import { SignJWT } from "jose";
import { NextResponse } from "next/server";

import { colorForUser } from "@quorum/shared/colors";

import { resolveViewer } from "@/lib/auth/viewer";
import { env } from "@/lib/env";
import type { BoardTokenResponse } from "@/lib/api/types";
import { getMembership } from "@/lib/server/boards";
import { jsonError, serverError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";

interface RouteContext {
  params: Promise<{ boardId: string }>;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * POST /api/boards/:boardId/token — mint the board websocket JWT (build
 * brief "Board websocket auth token"): HS256 over AUTH_SECRET, claims
 * { sub, boardId, role, name, color }, 10 minute expiry. The Hocuspocus
 * provider fetches a fresh one on every (re)connect.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    // 120/min per IP: every board load and every ws reconnect mints one, so a
    // flaky network or several tabs behind one NAT must never trip this — it
    // exists only to cap an outright loop.
    const limited = await enforceRateLimit(request, {
      bucket: "boards.token",
      limit: 120,
      windowSec: 60,
    });
    if (limited) return limited;

    const { boardId } = await context.params;
    const viewer = await resolveViewer();
    if (!viewer) return jsonError(401, "unauthenticated", "Sign in or open an invite link first.");

    const access = await getMembership(boardId, viewer.id);
    if (!access) {
      return jsonError(
        403,
        "forbidden",
        "You are not a member of this board — ask for an invite link.",
      );
    }

    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const token = await new SignJWT({
      boardId,
      role: access.membership.role,
      name: viewer.name,
      color: colorForUser(viewer.id),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(viewer.id)
      .setIssuedAt()
      .setExpirationTime(new Date(expiresAt))
      .sign(new TextEncoder().encode(env.AUTH_SECRET));

    // lastSeenAt upkeep (the active-quorum signal) is the ws server's job —
    // it sees real connections; a token mint only proves intent to connect.
    return NextResponse.json({ token, expiresAt } satisfies BoardTokenResponse);
  } catch (error) {
    return serverError("boards.token.failed", error);
  }
}
