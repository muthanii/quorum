import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@quorum/db/client";
import { inviteLinks } from "@quorum/db/schema";

import { resolveViewer } from "@/lib/auth/viewer";
import type { CreateInviteResponse } from "@/lib/api/types";
import { getMembership } from "@/lib/server/boards";
import { jsonError, readJson, serverError } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { originFromRequest } from "@/lib/server/origin";

interface RouteContext {
  params: Promise<{ boardId: string }>;
}

const createInviteSchema = z
  .object({
    role: z.enum(["editor", "viewer"]),
  })
  .strict();

/**
 * POST /api/boards/:boardId/invites — one-click share. Returns a link
 * (NEXT_PUBLIC_APP_URL/i/<token>). Viewer invites join instantly; editor
 * invites stage an invite_member proposal at acceptance time and the invitee
 * participates as a viewer until everyone approves (CLAUDE.md §6).
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { boardId } = await context.params;
    const body = await readJson(request, createInviteSchema);
    if (!body.ok) return body.response;

    const viewer = await resolveViewer();
    if (!viewer) return jsonError(401, "unauthenticated", "Sign in or open an invite link first.");

    const access = await getMembership(boardId, viewer.id);
    if (!access) {
      return jsonError(403, "forbidden", "You are not a member of this board.");
    }
    if (access.membership.role === "viewer") {
      return jsonError(403, "forbidden", "Viewers cannot create invite links.");
    }

    const db = getDb();
    const [invite] = await db
      .insert(inviteLinks)
      .values({ boardId, role: body.data.role, createdBy: viewer.id })
      .returning({ token: inviteLinks.token });
    if (!invite) throw new Error("invite insert returned no row");

    log.info("invites.create", { boardId, role: body.data.role, createdBy: viewer.id });
    return NextResponse.json(
      {
        token: invite.token,
        role: body.data.role,
        url: `${originFromRequest(request)}/i/${invite.token}`,
      } satisfies CreateInviteResponse,
      { status: 201 },
    );
  } catch (error) {
    return serverError("invites.create.failed", error);
  }
}
