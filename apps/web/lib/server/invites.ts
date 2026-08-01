/**
 * Invite links — sharing is one click. Viewer invites join instantly; editor
 * invites land the user as a viewer and an invite_member proposal gates the
 * role upgrade (CLAUDE.md §6 — surfaced honestly in the UI).
 */
import { getDb } from "@quorum/db/client";
import { boardMembers, type InviteLinkRow } from "@quorum/db/schema";

export type InviteLookup =
  | { status: "not_found" }
  | { status: "expired"; invite: InviteLinkRow }
  | { status: "ok"; invite: InviteLinkRow };

export async function lookupInvite(token: string, now: Date = new Date()): Promise<InviteLookup> {
  const db = getDb();
  const invite = await db.query.inviteLinks.findFirst({
    where: (invites, { eq }) => eq(invites.token, token),
  });
  if (!invite) return { status: "not_found" };
  if (invite.expiresAt !== null && invite.expiresAt.getTime() <= now.getTime()) {
    return { status: "expired", invite };
  }
  return { status: "ok", invite };
}

export interface AcceptInviteResult {
  boardId: string;
  /**
   * True when the invite was for editor and the user currently holds only
   * viewer — the client must stage the invite_member proposal in the doc
   * (REST cannot write the Y.Doc) and show honest "pending approval" copy.
   */
  editorPending: boolean;
}

/** Idempotent: re-accepting an invite never downgrades an existing role. */
export async function acceptInvite(
  invite: InviteLinkRow,
  userId: string,
): Promise<AcceptInviteResult> {
  const db = getDb();
  const existing = await db.query.boardMembers.findFirst({
    columns: { role: true },
    where: (members, { and, eq }) =>
      and(eq(members.boardId, invite.boardId), eq(members.userId, userId)),
  });

  if (!existing) {
    // Editor invites also start at viewer: the upgrade is a proposal, never
    // a silent grant (unanimous by default).
    await db
      .insert(boardMembers)
      .values({ boardId: invite.boardId, userId, role: "viewer", lastSeenAt: new Date() })
      .onConflictDoNothing();
  }

  const currentRole = existing?.role ?? "viewer";
  return {
    boardId: invite.boardId,
    editorPending: invite.role === "editor" && currentRole === "viewer",
  };
}
