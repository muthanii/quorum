/**
 * The ws server's entire Postgres surface, as narrow injectable interfaces.
 * Everything above this module (persistence, presence, consensus, internal
 * API) depends on these interfaces, never on drizzle directly, so unit tests
 * inject plain-object fakes and need no database.
 *
 * SECURITY: the agents queries select display-safe columns ONLY. Credential
 * ciphertext, IVs, tags, and signing secrets are never read by this process.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import type { Db } from "@quorum/db/client";
import {
  agents,
  boardMembers,
  boards,
  proposalsAudit,
  votesAudit,
  yjsSnapshots,
  yjsUpdates,
} from "@quorum/db/schema";
import type { Resolution } from "@quorum/shared/consensus/types";
import type { AgentKind, AgentStatus } from "@quorum/shared/schemas/agent";
import type { MemberRole } from "@quorum/shared/schemas/member";
import { DEFAULT_POLICY, policySchema, type ConsensusPolicy } from "@quorum/shared/schemas/policy";
import type { Proposal, ProposalStatus } from "@quorum/shared/schemas/proposal";
import type { VoteValue } from "@quorum/shared/schemas/vote";

import { serializeError, type Logger } from "./log";

/** Snapshots kept per board beyond the newest, as a manual recovery fallback. */
const SNAPSHOT_RETENTION = 3;

/**
 * Rows affected by a DELETE, across driver result shapes.
 *
 * Order matters: postgres-js returns an Array SUBCLASS that carries the real
 * figure on `.count`, and without a RETURNING clause its `.length` is 0. An
 * `Array.isArray` check first therefore reports every delete as having removed
 * nothing — which is exactly what the compaction log claimed before this.
 */
export function rowsAffected(result: unknown): number {
  if (typeof result === "object" && result !== null) {
    const record = result as { count?: unknown; rowCount?: unknown };
    if (typeof record.count === "number") return record.count;
    if (typeof record.rowCount === "number") return record.rowCount;
  }
  if (Array.isArray(result)) return result.length;
  return 0;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface BoardRecord {
  id: string;
  ownerUserId: string;
  /** Parsed consensusPolicy; falls back to DEFAULT_POLICY when malformed. */
  policy: ConsensusPolicy;
}

export interface MemberRecord {
  userId: string;
  role: MemberRole;
  /** Unix epoch ms; 0 when the member was never seen. */
  lastSeenAtMs: number;
}

/** Display-safe agent projection — never carries credential material. */
export interface AgentRecord {
  id: string;
  boardId: string;
  name: string;
  kind: AgentKind;
  status: AgentStatus;
}

export interface BoardStore {
  getBoard(boardId: string): Promise<BoardRecord | null>;
  updateBoardPolicy(boardId: string, policy: ConsensusPolicy): Promise<void>;
  listMembers(boardId: string): Promise<MemberRecord[]>;
  /** Bump lastSeenAt for the given users on a board (presence heartbeat). */
  touchMembers(boardId: string, userIds: string[], at: Date): Promise<void>;
  listAgents(boardId: string): Promise<AgentRecord[]>;
  getAgent(boardId: string, agentId: string): Promise<AgentRecord | null>;
  setAgentStatus(agentId: string, status: AgentStatus): Promise<void>;
  removeAgent(agentId: string): Promise<void>;
}

/** What one compacting snapshot write removed. Zeroes when nothing was pruned. */
export interface SnapshotWriteResult {
  prunedUpdates: number;
  prunedSnapshots: number;
}

export interface SnapshotStore {
  loadLatestSnapshot(boardId: string): Promise<{ seq: number; snapshot: Uint8Array } | null>;
  /** The full raw update log for the board, oldest first. */
  listUpdates(boardId: string): Promise<Uint8Array[]>;
  appendUpdate(boardId: string, update: Uint8Array): Promise<void>;
  /**
   * Highest update id currently stored for the board, or null when the log is
   * empty. Read BEFORE encoding a snapshot: Hocuspocus applies an update to the
   * document before onChange persists it, so a row at or below this id is
   * guaranteed to be inside a snapshot encoded afterwards. Rows appended during
   * the encode land above the mark and survive.
   */
  latestUpdateId(boardId: string): Promise<number | null>;
  /**
   * Store a snapshot at the next monotonic seq, and in the SAME transaction
   * drop the updates it subsumes plus snapshots older than the retention
   * window. Pass `compactThrough: null` to write without compacting.
   */
  storeSnapshot(
    boardId: string,
    snapshot: Uint8Array,
    compactThrough: number | null,
  ): Promise<SnapshotWriteResult>;
}

export interface AuditVote {
  memberId: string;
  value: VoteValue;
  /** Unix epoch ms. */
  at: number;
}

export interface AuditStore {
  /** Insert the open audit row when a proposal is staged. Idempotent. */
  recordProposalCreated(boardId: string, proposal: Proposal): Promise<void>;
  /**
   * Write the authoritative resolution + the votes that produced it.
   * Append-only: only status/resolution/resolvedAt are ever set, once.
   */
  recordResolution(input: {
    boardId: string;
    proposal: Proposal;
    status: ProposalStatus;
    resolution: Resolution;
    votes: AuditVote[];
    resolvedAt: Date;
  }): Promise<void>;
}

export interface Stores {
  boards: BoardStore;
  snapshots: SnapshotStore;
  audit: AuditStore;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

const agentColumns = {
  id: agents.id,
  boardId: agents.boardId,
  name: agents.name,
  kind: agents.kind,
  status: agents.status,
};

export function createStores(db: Db, log: Logger): Stores {
  const boardStore: BoardStore = {
    async getBoard(boardId) {
      const rows = await db
        .select({ id: boards.id, ownerId: boards.ownerId, consensusPolicy: boards.consensusPolicy })
        .from(boards)
        .where(eq(boards.id, boardId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      const parsed = policySchema.safeParse(row.consensusPolicy);
      if (!parsed.success) {
        log.warn("board has a malformed consensusPolicy — falling back to DEFAULT_POLICY", {
          boardId,
        });
      }
      return {
        id: row.id,
        ownerUserId: row.ownerId,
        policy: parsed.success ? parsed.data : DEFAULT_POLICY,
      };
    },

    async updateBoardPolicy(boardId, policy) {
      await db.update(boards).set({ consensusPolicy: policy }).where(eq(boards.id, boardId));
    },

    async listMembers(boardId) {
      const rows = await db
        .select({
          userId: boardMembers.userId,
          role: boardMembers.role,
          lastSeenAt: boardMembers.lastSeenAt,
        })
        .from(boardMembers)
        .where(eq(boardMembers.boardId, boardId));
      return rows.map((row) => ({
        userId: row.userId,
        role: row.role,
        lastSeenAtMs: row.lastSeenAt?.getTime() ?? 0,
      }));
    },

    async touchMembers(boardId, userIds, at) {
      if (userIds.length === 0) return;
      await db
        .update(boardMembers)
        .set({ lastSeenAt: at })
        .where(and(eq(boardMembers.boardId, boardId), inArray(boardMembers.userId, userIds)));
    },

    async listAgents(boardId) {
      return db.select(agentColumns).from(agents).where(eq(agents.boardId, boardId));
    },

    async getAgent(boardId, agentId) {
      const rows = await db
        .select(agentColumns)
        .from(agents)
        .where(and(eq(agents.boardId, boardId), eq(agents.id, agentId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async setAgentStatus(agentId, status) {
      await db.update(agents).set({ status }).where(eq(agents.id, agentId));
    },

    async removeAgent(agentId) {
      await db.delete(agents).where(eq(agents.id, agentId));
    },
  };

  const snapshotStore: SnapshotStore = {
    async loadLatestSnapshot(boardId) {
      const row = await db.query.yjsSnapshots.findFirst({
        columns: { seq: true, snapshot: true },
        where: (table, operators) => operators.eq(table.boardId, boardId),
        orderBy: (table, operators) => operators.desc(table.seq),
      });
      return row === undefined ? null : { seq: row.seq, snapshot: row.snapshot };
    },

    async listUpdates(boardId) {
      const rows = await db.query.yjsUpdates.findMany({
        columns: { update: true },
        where: (table, operators) => operators.eq(table.boardId, boardId),
        orderBy: (table, operators) => operators.asc(table.id),
      });
      return rows.map((row) => row.update);
    },

    async appendUpdate(boardId, update) {
      await db.insert(yjsUpdates).values({ boardId, update: Buffer.from(update) });
    },

    async latestUpdateId(boardId) {
      const row = await db.query.yjsUpdates.findFirst({
        columns: { id: true },
        where: (table, operators) => operators.eq(table.boardId, boardId),
        orderBy: (table, operators) => operators.desc(table.id),
      });
      return row?.id ?? null;
    },

    async storeSnapshot(boardId, snapshot, compactThrough) {
      // One transaction: a snapshot must never be pruned against unless it is
      // itself durable, or a crash between the two statements loses history.
      return db.transaction(async (tx) => {
        await tx.insert(yjsSnapshots).values({
          boardId,
          snapshot: Buffer.from(snapshot),
          seq: sql<number>`coalesce((select max(${yjsSnapshots.seq}) from ${yjsSnapshots} where ${yjsSnapshots.boardId} = ${boardId}), 0) + 1`,
        });
        // Nothing to prune when the log is empty, but snapshot retention still
        // runs below — an idle board keeps writing snapshots on every store,
        // and those are the larger rows.
        const prunedUpdates =
          compactThrough === null
            ? 0
            : rowsAffected(
                await tx
                  .delete(yjsUpdates)
                  .where(and(eq(yjsUpdates.boardId, boardId), lte(yjsUpdates.id, compactThrough))),
              );
        // Keep a few older snapshots as a manual fallback if the newest one is
        // ever unreadable; without a cap they are the bigger leak of the two,
        // since each is the whole document rather than one delta.
        const prunedSnapshots = await tx
          .delete(yjsSnapshots)
          .where(
            and(
              eq(yjsSnapshots.boardId, boardId),
              lte(
                yjsSnapshots.seq,
                sql<number>`coalesce((select max(${yjsSnapshots.seq}) from ${yjsSnapshots} where ${yjsSnapshots.boardId} = ${boardId}), 0) - ${SNAPSHOT_RETENTION}`,
              ),
            ),
          );
        return { prunedUpdates, prunedSnapshots: rowsAffected(prunedSnapshots) };
      });
    },
  };

  const auditStore: AuditStore = {
    async recordProposalCreated(boardId, proposal) {
      await db
        .insert(proposalsAudit)
        .values({
          proposalId: proposal.id,
          boardId,
          kind: proposal.kind,
          authorId: proposal.authorId,
          authorKind: proposal.authorKind,
          payload: proposal.payload,
          status: "open",
          createdAt: new Date(proposal.createdAt),
        })
        .onConflictDoNothing({ target: proposalsAudit.proposalId });
    },

    async recordResolution({ boardId, proposal, status, resolution, votes, resolvedAt }) {
      await db
        .insert(proposalsAudit)
        .values({
          proposalId: proposal.id,
          boardId,
          kind: proposal.kind,
          authorId: proposal.authorId,
          authorKind: proposal.authorKind,
          payload: proposal.payload,
          status,
          resolution,
          createdAt: new Date(proposal.createdAt),
          resolvedAt,
        })
        .onConflictDoUpdate({
          target: proposalsAudit.proposalId,
          set: { status, resolution, resolvedAt },
        });
      if (votes.length > 0) {
        await db.insert(votesAudit).values(
          votes.map((vote) => ({
            proposalId: proposal.id,
            memberId: vote.memberId,
            value: vote.value,
            castAt: new Date(vote.at),
          })),
        );
      }
    },
  };

  return { boards: boardStore, snapshots: snapshotStore, audit: auditStore };
}

/** Shared helper so callers can log a store failure without re-throwing. */
export function logStoreError(
  log: Logger,
  msg: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  log.error(msg, { ...fields, ...serializeError(error) });
}
