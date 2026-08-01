import { NextResponse } from "next/server";

import { getDb } from "@quorum/db/client";
import { boardMembers } from "@quorum/db/schema";
import { proposalPayloadSchema } from "@quorum/shared/schemas/proposal";

import { resolveViewer } from "@/lib/auth/viewer";
import { getMembership } from "@/lib/server/boards";
import { jsonError, serverError } from "@/lib/server/http";
import { log } from "@/lib/server/log";

interface RouteContext {
  params: Promise<{ boardId: string }>;
}

/**
 * POST /api/boards/:boardId/members/claim-editor — the web-side half of the
 * invite_member pipeline. When an invite_member proposal passes, the ws
 * server marks it applied and audits it to Postgres, but delegates the
 * side effect to the web app (apps/ws/src/consensus.ts). This endpoint
 * EXECUTES that audited outcome: the caller is upgraded viewer → editor if
 * and only if proposals_audit holds an APPLIED invite_member proposal
 * authored for them on this board. Without a ws-audited unanimous approval
 * it answers 409 — no consensus is ever bypassed here.
 *
 * Called today by the e2e suite after the vote resolves (e2e/helpers/board.ts);
 * the board UI can adopt the same call when it wires an applied-status watch.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { boardId } = await context.params;
    const viewer = await resolveViewer();
    if (!viewer) return jsonError(401, "unauthenticated", "Sign in or open an invite link first.");

    const access = await getMembership(boardId, viewer.id);
    if (!access) return jsonError(403, "forbidden", "You are not a member of this board.");
    if (access.membership.role !== "viewer") {
      // Already editor or owner — nothing to claim; keep the call idempotent.
      return NextResponse.json({ role: access.membership.role });
    }

    const db = getDb();
    const audited = await db.query.proposalsAudit.findMany({
      columns: { proposalId: true, payload: true },
      where: (proposals, { and, eq }) =>
        and(
          eq(proposals.boardId, boardId),
          eq(proposals.kind, "invite_member"),
          eq(proposals.authorId, viewer.id),
          eq(proposals.status, "applied"),
        ),
    });
    // Only an editor grant is claimable — owner transfer is out of scope and
    // an unparseable payload row proves nothing.
    const grant = audited.find((row) => {
      const payload = proposalPayloadSchema.safeParse(row.payload);
      return (
        payload.success && payload.data.kind === "invite_member" && payload.data.role === "editor"
      );
    });
    if (grant === undefined) {
      return jsonError(
        409,
        "no_applied_invite",
        "No approved editor-access proposal for you on this board yet — the vote must resolve first.",
      );
    }

    await db
      .insert(boardMembers)
      .values({ boardId, userId: viewer.id, role: "editor", lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: [boardMembers.boardId, boardMembers.userId],
        set: { role: "editor" },
      });

    log.info("members.claim_editor", { boardId, userId: viewer.id, proposalId: grant.proposalId });
    return NextResponse.json({ role: "editor" });
  } catch (error) {
    return serverError("members.claim_editor.failed", error);
  }
}
