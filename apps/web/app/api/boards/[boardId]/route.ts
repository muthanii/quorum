import { NextResponse } from "next/server";

import { resolveViewer } from "@/lib/auth/viewer";
import { getBoardDetail } from "@/lib/server/boards";
import { jsonError, serverError } from "@/lib/server/http";

interface RouteContext {
  params: Promise<{ boardId: string }>;
}

/**
 * GET /api/boards/:boardId — board + members + agents (maskedKey ONLY) +
 * policy + the viewer's own membership. Requires membership: an invite link
 * grants membership first (see /i/[token]), a bare board id grants nothing.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { boardId } = await context.params;
    const viewer = await resolveViewer();
    if (!viewer) return jsonError(401, "unauthenticated", "Sign in or open an invite link first.");

    const result = await getBoardDetail(boardId, viewer.id);
    if (result.status === "not_found") {
      return jsonError(404, "not_found", "This board does not exist.");
    }
    if (result.status === "forbidden") {
      return jsonError(
        403,
        "forbidden",
        "You are not a member of this board — ask for an invite link.",
      );
    }
    return NextResponse.json(result.detail);
  } catch (error) {
    return serverError("boards.get.failed", error);
  }
}
