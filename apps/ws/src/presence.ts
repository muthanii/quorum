/**
 * Per-board presence: which member ids have a live websocket right now, and
 * keeping board_members.lastSeenAt fresh (on connect, on disconnect, and on a
 * periodic heartbeat while connected) so the 5-minute "active" quorum window
 * works across ws restarts.
 *
 * Every connect/disconnect notifies the consensus controller so open
 * proposals are re-evaluated immediately — the UI shows the quorum
 * recalculation instead of a silent threshold change.
 */
import { activeMemberIds, type QuorumMember } from "@quorum/shared/consensus/quorum";

import type { BoardConnectionContext } from "./auth";
import { serializeError, type Logger } from "./log";
import type { BoardStore } from "./stores";

export interface ConnectedPeer {
  socketId: string;
  userId: string;
  memberId?: string;
  role: BoardConnectionContext["role"];
}

export interface PresenceDeps {
  boards: Pick<BoardStore, "touchMembers">;
  log: Logger;
  now?: () => number;
  /** How often lastSeenAt is refreshed for connected members. */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 60_000;

export class PresenceTracker {
  /** boardId → socketId → peer. One user with two tabs = two entries. */
  private readonly peers = new Map<string, Map<string, ConnectedPeer>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  /** Wired by server.ts to the consensus controller's re-evaluation. */
  onQuorumChange: ((boardId: string) => void) | null = null;

  constructor(private readonly deps: PresenceDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    const interval = this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.timer = setInterval(() => {
      void this.heartbeat();
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async connect(boardId: string, socketId: string, ctx: BoardConnectionContext): Promise<void> {
    let board = this.peers.get(boardId);
    if (board === undefined) {
      board = new Map();
      this.peers.set(boardId, board);
    }
    board.set(socketId, {
      socketId,
      userId: ctx.userId,
      ...(ctx.memberId !== undefined ? { memberId: ctx.memberId } : {}),
      role: ctx.role,
    });
    await this.touch(boardId, [ctx.userId]);
    this.onQuorumChange?.(boardId);
  }

  async disconnect(boardId: string, socketId: string): Promise<void> {
    const board = this.peers.get(boardId);
    if (board === undefined) return;
    const peer = board.get(socketId);
    board.delete(socketId);
    if (board.size === 0) this.peers.delete(boardId);
    if (peer !== undefined) {
      // They were seen right now — the 5-minute window starts from here, so
      // a brief disconnect never silently shrinks the quorum.
      await this.touch(boardId, [peer.userId]);
    }
    this.onQuorumChange?.(boardId);
  }

  connectedPeers(boardId: string): ConnectedPeer[] {
    return [...(this.peers.get(boardId)?.values() ?? [])];
  }

  /**
   * The engine's activeMemberIds input: live connections merged with the
   * board's persisted membership. Connected peers are listed first so guests
   * without a board_members row still count while connected.
   */
  activeIds(
    boardId: string,
    members: {
      userId: string;
      role: QuorumMember["role"];
      lastSeenAtMs: number;
      memberId?: string;
    }[],
  ): string[] {
    const now = this.now();
    const connected = this.connectedPeers(boardId).filter(
      (peer): peer is ConnectedPeer & { memberId: string } => peer.memberId !== undefined,
    );
    const quorumMembers: QuorumMember[] = [
      ...connected.map((peer) => ({ id: peer.memberId, role: peer.role, lastSeenAt: now })),
      ...members
        .filter(
          (member): member is typeof member & { memberId: string } => member.memberId !== undefined,
        )
        .map((member) => ({
          id: member.memberId,
          role: member.role,
          lastSeenAt: member.lastSeenAtMs,
        })),
    ];
    return activeMemberIds({
      members: quorumMembers,
      connectedIds: connected.map((peer) => peer.memberId),
      now,
    });
  }

  private async heartbeat(): Promise<void> {
    for (const [boardId, board] of this.peers) {
      const userIds = [...new Set([...board.values()].map((peer) => peer.userId))];
      await this.touch(boardId, userIds);
    }
  }

  private async touch(boardId: string, userIds: string[]): Promise<void> {
    try {
      await this.deps.boards.touchMembers(boardId, userIds, new Date(this.now()));
    } catch (error) {
      this.deps.log.error("failed to update lastSeenAt", {
        boardId,
        ...serializeError(error),
      });
    }
  }
}
