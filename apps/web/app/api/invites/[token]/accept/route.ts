import { NextResponse } from "next/server";

import { guestCookieOptions, GUEST_COOKIE } from "@/lib/auth/guest";
import { resolveViewer } from "@/lib/auth/viewer";
import { createGuest } from "@/lib/server/guests";
import { serverError } from "@/lib/server/http";
import { acceptInvite, lookupInvite } from "@/lib/server/invites";
import { log } from "@/lib/server/log";
import { originFromRequest } from "@/lib/server/origin";
import { enforceRateLimit } from "@/lib/server/rate-limit";

interface RouteContext {
  params: Promise<{ token: string }>;
}

/**
 * GET /api/invites/:token/accept — the mutating half of the invite flow.
 * The /i/[token] page validates and renders errors; this handler creates the
 * membership (and, for anonymous visitors, the guest identity + quorum_guest
 * cookie — a Server Component cannot set cookies, a route handler can) and
 * redirects into the board.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    // 20/min per IP: accepting is one navigation, and a whole team arriving
    // through the same office NAT still fits — it only stops a script farming
    // guest identities off one link.
    const limited = await enforceRateLimit(request, {
      bucket: "invites.accept",
      limit: 20,
      windowSec: 60,
    });
    if (limited) return limited;

    const { token } = await context.params;
    const lookup = await lookupInvite(token);
    if (lookup.status !== "ok") {
      // Send invalid/expired links back to the page, which renders the
      // explanation (it never redirects those back here, so no loop).
      return NextResponse.redirect(
        new URL(`/i/${encodeURIComponent(token)}`, originFromRequest(request)),
      );
    }

    const existingViewer = await resolveViewer();
    const guest = existingViewer ? null : await createGuest();
    const viewerId = existingViewer?.id ?? guest?.id;
    if (!viewerId) throw new Error("failed to resolve or create a viewer identity");

    const result = await acceptInvite(lookup.invite, viewerId);
    log.info("invites.accept", {
      boardId: result.boardId,
      inviteRole: lookup.invite.role,
      viewerId,
      viewerKind: existingViewer?.kind ?? "guest",
      editorPending: result.editorPending,
    });

    const destination = new URL(`/b/${result.boardId}`, originFromRequest(request));
    if (result.editorPending) destination.searchParams.set("editorRequested", "1");

    const response = NextResponse.redirect(destination);
    if (guest) {
      response.cookies.set(GUEST_COOKIE, guest.token, guestCookieOptions());
    }
    return response;
  } catch (error) {
    return serverError("invites.accept.failed", error);
  }
}
