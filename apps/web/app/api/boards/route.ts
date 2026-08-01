import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { guestCookieOptions, GUEST_COOKIE } from "@/lib/auth/guest";
import { resolveViewer, type Viewer } from "@/lib/auth/viewer";
import type { CreateBoardResponse, ListBoardsResponse } from "@/lib/api/types";
import { createBoardWithOwner, listBoardsForUser } from "@/lib/server/boards";
import { createGuest } from "@/lib/server/guests";
import { jsonError, readJson, serverError } from "@/lib/server/http";
import { log } from "@/lib/server/log";

const createBoardSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
  })
  .strict();

/**
 * POST /api/boards — create a board + owner membership. Zero setup: an
 * anonymous visitor gets a guest identity minted on the spot, so "New board"
 * works with no sign-in.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await readJson(request, createBoardSchema);
    if (!body.ok) return body.response;

    let viewer: Viewer | null = await resolveViewer();
    if (!viewer) {
      const guest = await createGuest();
      const cookieStore = await cookies();
      cookieStore.set(GUEST_COOKIE, guest.token, guestCookieOptions());
      viewer = { id: guest.id, name: guest.name, kind: "guest" };
    }

    const board = await createBoardWithOwner({
      ownerId: viewer.id,
      name: body.data.name ?? "Untitled Board",
    });
    log.info("boards.create", { boardId: board.id, ownerId: viewer.id, viewerKind: viewer.kind });
    return NextResponse.json({ board } satisfies CreateBoardResponse, { status: 201 });
  } catch (error) {
    return serverError("boards.create.failed", error);
  }
}

/** GET /api/boards — boards the viewer is a member of. */
export async function GET(): Promise<NextResponse> {
  try {
    const viewer = await resolveViewer();
    if (!viewer) return jsonError(401, "unauthenticated", "Sign in or open an invite link first.");
    const boards = await listBoardsForUser(viewer.id);
    return NextResponse.json({ boards } satisfies ListBoardsResponse);
  } catch (error) {
    return serverError("boards.list.failed", error);
  }
}
