/**
 * Board access + payload assembly, shared by the REST route handlers and the
 * board page's server-side fetch (no HTTP self-call). All reads are scoped
 * to the viewer's membership — a board id is not an authorization token.
 *
 * Queries use drizzle's relational API (db.query.*): apps/web deliberately
 * has no direct drizzle-orm dependency, and the operator callbacks keep it
 * that way.
 */
import { getDb } from "@quorum/db/client";
import { boardMembers, boards, type BoardMemberRow, type BoardRow } from "@quorum/db/schema";
import { colorForUser } from "@quorum/shared/colors";

import type { BoardDetailDto, BoardDto } from "@/lib/api/types";

/**
 * Agent endpoints are shown to every board member, so only the host may leave
 * the server — a path or query string can carry the agent's own secret.
 */
function safeEndpointHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "(unparseable)";
  }
}

export function toBoardDto(row: BoardRow): BoardDto {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    policy: row.consensusPolicy,
    createdAt: row.createdAt.getTime(),
  };
}

export async function createBoardWithOwner(input: {
  ownerId: string;
  name: string;
}): Promise<BoardDto> {
  const db = getDb();
  const [board] = await db
    .insert(boards)
    .values({ name: input.name, ownerId: input.ownerId })
    .returning();
  if (!board) throw new Error("board insert returned no row");
  await db.insert(boardMembers).values({
    boardId: board.id,
    userId: input.ownerId,
    role: "owner",
    lastSeenAt: new Date(),
  });
  return toBoardDto(board);
}

export async function listBoardsForUser(userId: string): Promise<BoardDto[]> {
  const db = getDb();
  const memberships = await db.query.boardMembers.findMany({
    columns: { boardId: true },
    where: (members, { eq }) => eq(members.userId, userId),
  });
  const boardIds = memberships.map((membership) => membership.boardId);
  if (boardIds.length === 0) return [];
  const rows = await db.query.boards.findMany({
    where: (boards, { inArray }) => inArray(boards.id, boardIds),
    orderBy: (boards, { desc }) => desc(boards.createdAt),
  });
  return rows.map(toBoardDto);
}

export async function getMembership(
  boardId: string,
  userId: string,
): Promise<{ board: BoardRow; membership: BoardMemberRow } | null> {
  const db = getDb();
  const board = await db.query.boards.findFirst({
    where: (boards, { eq }) => eq(boards.id, boardId),
  });
  if (!board) return null;
  const membership = await db.query.boardMembers.findFirst({
    where: (members, { and, eq }) => and(eq(members.boardId, boardId), eq(members.userId, userId)),
  });
  if (!membership) return null;
  return { board, membership };
}

export type BoardDetailResult =
  { status: "not_found" } | { status: "forbidden" } | { status: "ok"; detail: BoardDetailDto };

export async function getBoardDetail(
  boardId: string,
  viewerId: string,
): Promise<BoardDetailResult> {
  const db = getDb();
  const board = await db.query.boards.findFirst({
    where: (boards, { eq }) => eq(boards.id, boardId),
  });
  if (!board) return { status: "not_found" };

  const memberRows = await db.query.boardMembers.findMany({
    where: (members, { eq }) => eq(members.boardId, boardId),
  });
  const selfRow = memberRows.find((member) => member.userId === viewerId);
  if (!selfRow) return { status: "forbidden" };

  const userIds = memberRows.map((member) => member.userId);
  const userRows =
    userIds.length === 0
      ? []
      : await db.query.users.findMany({
          columns: { id: true, name: true },
          where: (users, { inArray }) => inArray(users.id, userIds),
        });
  const nameByUserId = new Map(userRows.map((user) => [user.id, user.name]));

  // Explicit column whitelist: the encrypted credential columns must never
  // be selected into anything that could reach a response.
  const agentRows = await db.query.agents.findMany({
    columns: {
      id: true,
      ownerId: true,
      name: true,
      kind: true,
      endpointUrl: true,
      maskedKey: true,
      status: true,
      createdAt: true,
    },
    where: (agents, { eq }) => eq(agents.boardId, boardId),
  });

  return {
    status: "ok",
    detail: {
      board: toBoardDto(board),
      members: memberRows.map((member) => ({
        userId: member.userId,
        name: nameByUserId.get(member.userId) ?? "Member",
        role: member.role,
        color: colorForUser(member.userId),
        lastSeenAt: member.lastSeenAt?.getTime() ?? null,
        joinedAt: member.joinedAt.getTime(),
      })),
      agents: agentRows.map((agent) => ({
        id: agent.id,
        ownerId: agent.ownerId,
        name: agent.name,
        kind: agent.kind,
        endpointHost: safeEndpointHost(agent.endpointUrl),
        maskedKey: agent.maskedKey,
        status: agent.status,
        createdAt: agent.createdAt.getTime(),
      })),
      self: {
        id: viewerId,
        name: nameByUserId.get(viewerId) ?? "Member",
        role: selfRow.role,
        color: colorForUser(viewerId),
      },
    },
  };
}
