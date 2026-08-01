import { NextResponse } from "next/server";

import { getDb } from "@quorum/db/client";

import { resolveViewer } from "@/lib/auth/viewer";
import type { RemoveAgentResponse } from "@/lib/api/types";
import { getMembership } from "@/lib/server/boards";
import { jsonError, serverError } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { buildHumanProposal } from "@/lib/server/proposals";

interface RouteContext {
  params: Promise<{ boardId: string; agentId: string }>;
}

/**
 * DELETE /api/boards/:boardId/agents/:agentId — stage a remove_agent
 * Proposal. Nothing is deleted here: removing an agent requires consensus
 * (CLAUDE.md §6), so this returns the proposal for the CLIENT to stage via
 * createProposalInDoc (REST cannot write the Y.Doc); the ws server deletes
 * the row when the approved proposal is applied.
 */
export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { boardId, agentId } = await context.params;
    const viewer = await resolveViewer();
    if (!viewer) return jsonError(401, "unauthenticated", "Sign in or open an invite link first.");

    const access = await getMembership(boardId, viewer.id);
    if (!access) return jsonError(403, "forbidden", "You are not a member of this board.");
    if (access.membership.role === "viewer") {
      return jsonError(403, "forbidden", "Viewers cannot remove agents.");
    }

    const db = getDb();
    const agent = await db.query.agents.findFirst({
      columns: { id: true, name: true },
      where: (agents, { and, eq }) => and(eq(agents.id, agentId), eq(agents.boardId, boardId)),
    });
    if (!agent) return jsonError(404, "not_found", "This agent is not on this board.");

    const proposal = buildHumanProposal({
      title: `Remove agent "${agent.name}"`,
      summary: `${viewer.name} wants to remove the agent "${agent.name}" from this board.`,
      authorId: viewer.id,
      payload: { kind: "remove_agent", agentId: agent.id },
      policy: access.board.consensusPolicy,
      now: Date.now(),
    });

    log.info("agents.remove.staged", { boardId, agentId, requestedBy: viewer.id });
    return NextResponse.json({ proposal } satisfies RemoveAgentResponse);
  } catch (error) {
    return serverError("agents.remove.failed", error);
  }
}
