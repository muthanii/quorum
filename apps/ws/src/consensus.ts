/**
 * The AUTHORITATIVE side of the consensus pipeline (CLAUDE.md §6). Clients
 * write only their own vote into a proposal's votes map; this controller
 * observes every loaded doc's proposals, runs the pure engine, writes the
 * resolution status back, applies approved operations atomically in ONE
 * doc.transact(), and audits proposal + votes to Postgres (append-only).
 *
 * Re-evaluation triggers:
 * - any change under the proposals map (votes, new proposals) via deep observer
 * - active-membership changes (presence connect/disconnect) — immediately,
 *   so the UI shows the quorum recalculation
 * - a 5s timer tick, which also expires timed-out proposals
 */
import { resolveProposal } from "@quorum/shared/consensus/engine";
import type { EngineVote, Resolution } from "@quorum/shared/consensus/types";
import { setBoardPolicy } from "@quorum/shared/yjs/board-meta";
import {
  applyOperationToDoc,
  appendMessage,
  getAgentStatusMap,
  getProposals,
  readProposal,
  setAgentStatus,
  setProposalStatus,
  type ProposalWithVotes,
} from "@quorum/shared/yjs/doc";
import { newId } from "@quorum/shared/ids";
import type { ProposalStatus } from "@quorum/shared/schemas/proposal";
import type * as Y from "yjs";

import { memberIdForUser } from "./auth";
import { enforceProposalWrites, GUARD_ORIGIN } from "./doc-guard";
import { serializeError, type Logger } from "./log";
import type { PresenceTracker } from "./presence";
import type { AuditStore, BoardStore } from "./stores";
import type { TurnDispatcher } from "./turns";

/** Transaction origin for every authoritative write — the observer skips it. */
export const CONSENSUS_ORIGIN = "quorum:consensus";

export interface ConsensusDeps {
  boards: BoardStore;
  audit: AuditStore;
  presence: PresenceTracker;
  turns: TurnDispatcher;
  log: Logger;
  now?: () => number;
  /** Timer tick for open proposals (timeout expiry). Default 5s. */
  tickMs?: number;
}

interface AttachedBoard {
  doc: Y.Doc;
  proposals: Y.Map<Y.Map<unknown>>;
  observer: (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction) => void;
}

const DEFAULT_TICK_MS = 5_000;

export class ConsensusController {
  private readonly attached = new Map<string, AttachedBoard>();
  private readonly chains = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ConsensusDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      for (const boardId of this.attached.keys()) this.scheduleEvaluation(boardId);
    }, this.deps.tickMs ?? DEFAULT_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Register a loaded doc: mirror the authoritative policy into boardMeta
   * (live policy badge), start observing proposals, and evaluate whatever is
   * already open (e.g. proposals that expired while the doc was unloaded).
   */
  async attach(boardId: string, doc: Y.Doc): Promise<void> {
    if (this.attached.has(boardId)) return;
    const proposals = getProposals(doc);
    const observer: AttachedBoard["observer"] = (events, txn) => {
      if (txn.origin === CONSENSUS_ORIGIN || txn.origin === GUARD_ORIGIN) return;
      // Strip forged votes BEFORE evaluating: the engine must never see a vote
      // the connection that wrote it was not entitled to cast.
      enforceProposalWrites(doc, events, txn, this.deps.log, boardId);
      this.scheduleEvaluation(boardId);
    };
    proposals.observeDeep(observer);
    this.attached.set(boardId, { doc, proposals, observer });

    try {
      const board = await this.deps.boards.getBoard(boardId);
      if (board !== null) {
        doc.transact(() => setBoardPolicy(doc, board.policy), CONSENSUS_ORIGIN);
      } else {
        this.deps.log.warn("loaded a doc with no board row", { boardId });
      }
    } catch (error) {
      this.deps.log.error("failed to mirror board policy", {
        boardId,
        ...serializeError(error),
      });
    }
    await this.evaluateBoard(boardId);
  }

  detach(boardId: string): void {
    const board = this.attached.get(boardId);
    if (board === undefined) return;
    try {
      board.proposals.unobserveDeep(board.observer);
    } catch {
      // Doc already destroyed by Hocuspocus unload.
    }
    this.attached.delete(boardId);
    this.chains.delete(boardId);
  }

  /** Queue a re-evaluation; evaluations for one board never overlap. */
  scheduleEvaluation(boardId: string): void {
    const prev = this.chains.get(boardId) ?? Promise.resolve();
    const next = prev
      .then(() => this.evaluateBoardNow(boardId))
      .catch((error: unknown) => {
        this.deps.log.error("consensus evaluation failed", {
          boardId,
          ...serializeError(error),
        });
      });
    this.chains.set(boardId, next);
  }

  /** Evaluate now and wait for every already-queued evaluation too. */
  async evaluateBoard(boardId: string): Promise<void> {
    this.scheduleEvaluation(boardId);
    await this.idle(boardId);
  }

  async idle(boardId: string): Promise<void> {
    // The chain can grow while we wait (e.g. a policy change re-queues), so
    // loop until it is stable.
    let current = this.chains.get(boardId);
    while (current !== undefined) {
      await current;
      const next = this.chains.get(boardId);
      if (next === current) return;
      current = next;
    }
  }

  private async evaluateBoardNow(boardId: string): Promise<void> {
    const attached = this.attached.get(boardId);
    if (attached === undefined || attached.doc.isDestroyed) return;
    const { doc, proposals } = attached;

    // Cheap pre-check before touching Postgres on every 5s tick.
    const openIds = [...proposals.keys()].filter((id) => readProposal(doc, id)?.status === "open");
    if (openIds.length === 0) return;

    const board = await this.deps.boards.getBoard(boardId);
    if (board === null) return;
    let policy = board.policy;
    const ownerMemberId = memberIdForUser(board.ownerUserId);

    const members = await this.deps.boards.listMembers(boardId);
    const quorumInput = members.map((member) => {
      const memberId = memberIdForUser(member.userId);
      return {
        userId: member.userId,
        role: member.role,
        lastSeenAtMs: member.lastSeenAtMs,
        ...(memberId !== undefined ? { memberId } : {}),
      };
    });
    const activeIds = this.deps.presence.activeIds(boardId, quorumInput);

    let policyChanged = false;
    for (const proposalId of openIds) {
      if (attached.doc.isDestroyed) return;
      const proposal = readProposal(doc, proposalId);
      if (proposal === null || proposal.status !== "open") continue;

      const authorId =
        proposal.authorKind === "human"
          ? (memberIdForUser(proposal.authorId) ?? proposal.authorId)
          : proposal.authorId;
      // Clients key votes by their usr_ id (BoardShell passes self.id); the
      // engine tallies against mem_-derived activeMemberIds. Normalize at the
      // authoritative boundary so both id spaces count.
      const votes: EngineVote[] = Object.entries(proposal.votes).map(([voterKey, vote]) => ({
        memberId: memberIdForUser(voterKey) ?? voterKey,
        value: vote.value,
        at: vote.at,
      }));

      const resolution = resolveProposal({
        proposal: {
          id: proposal.id,
          authorId,
          authorKind: proposal.authorKind,
          createdAt: proposal.createdAt,
          expiresAt: proposal.expiresAt,
        },
        votes,
        policy,
        activeMemberIds: activeIds,
        now: this.now(),
        ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
      });
      if (resolution.outcome === "open") continue;

      const applied = await this.applyResolution(boardId, doc, proposal, resolution, votes);
      if (proposal.kind === "policy_change" && applied === "applied") {
        policyChanged = true;
        // Remaining proposals in this pass are judged under the new policy.
        const refreshed = await this.deps.boards.getBoard(boardId);
        if (refreshed !== null) policy = refreshed.policy;
      }
    }

    if (policyChanged) {
      // Proposals evaluated earlier in this pass must be re-judged under the
      // new policy (build brief "Consensus semantics").
      this.scheduleEvaluation(boardId);
    }
  }

  /**
   * Write the resolution into the doc and perform the approved effect.
   * The doc mutation is ONE transaction: status + operation land together or
   * not at all. Postgres-side effects (policy of record, agent rows) are
   * written BEFORE the doc so a pg failure leaves the proposal open and
   * retryable instead of applied-but-unrecorded.
   */
  private async applyResolution(
    boardId: string,
    doc: Y.Doc,
    proposal: ProposalWithVotes,
    resolution: Resolution,
    votes: EngineVote[],
  ): Promise<ProposalStatus | null> {
    const log = this.deps.log.child({ boardId, proposalId: proposal.id, kind: proposal.kind });
    const now = this.now();
    let status: ProposalStatus;
    let finalResolution: Resolution = resolution;

    if (resolution.outcome !== "approved") {
      status = resolution.outcome === "expired" ? "expired" : "rejected";
      doc.transact(() => {
        setProposalStatus(doc, proposal.id, status);
      }, CONSENSUS_ORIGIN);
    } else {
      const { payload } = proposal;
      try {
        switch (payload.kind) {
          case "artifact_create":
          case "artifact_patch": {
            doc.transact(() => {
              // Validation happens before any mutation, so a throw leaves the
              // doc untouched and the status below is never written.
              applyOperationToDoc(doc, payload.operation, {
                now,
                ...(payload.kind === "artifact_create" &&
                proposal.affectedArtifactIds[0] !== undefined
                  ? { artifactId: proposal.affectedArtifactIds[0] }
                  : {}),
                ...(proposal.authorKind === "agent" ? { authorAgentId: proposal.authorId } : {}),
              });
              setProposalStatus(doc, proposal.id, "applied");
            }, CONSENSUS_ORIGIN);
            break;
          }
          case "policy_change": {
            await this.deps.boards.updateBoardPolicy(boardId, payload.policy);
            doc.transact(() => {
              setBoardPolicy(doc, payload.policy);
              setProposalStatus(doc, proposal.id, "applied");
            }, CONSENSUS_ORIGIN);
            break;
          }
          case "add_agent": {
            await this.deps.boards.setAgentStatus(payload.agentId, "ready");
            doc.transact(() => {
              // The agentStatus entry IS the participation flag — turns are
              // only dispatched to agents present in this map.
              setAgentStatus(doc, payload.agentId, "ready", now);
              setProposalStatus(doc, proposal.id, "applied");
            }, CONSENSUS_ORIGIN);
            break;
          }
          case "remove_agent": {
            await this.deps.boards.removeAgent(payload.agentId);
            doc.transact(() => {
              getAgentStatusMap(doc).delete(payload.agentId);
              setProposalStatus(doc, proposal.id, "applied");
            }, CONSENSUS_ORIGIN);
            break;
          }
          case "agent_prompt": {
            doc.transact(() => {
              setProposalStatus(doc, proposal.id, "applied");
            }, CONSENSUS_ORIGIN);
            await this.deps.turns.enqueueProposalApprovedTurn({
              boardId,
              doc,
              targetAgentId: payload.targetAgentId,
              prompt: {
                authorId: proposal.authorId,
                authorKind: proposal.authorKind,
                content: payload.content,
              },
            });
            break;
          }
          case "publish_artifact":
          case "invite_member": {
            // The side effect (export, invite email) is executed by the web
            // app, which watches for the applied status.
            doc.transact(() => {
              setProposalStatus(doc, proposal.id, "applied");
            }, CONSENSUS_ORIGIN);
            break;
          }
        }
        status = "applied";
      } catch (error) {
        // Approved but unappliable (e.g. the target artifact was deleted, or
        // pg is down for a pg-backed effect). For doc-validation failures we
        // resolve rejected with a visible explanation — never silently. For
        // transient pg errors we keep it open and let the next tick retry.
        if (
          payload.kind === "policy_change" ||
          payload.kind === "add_agent" ||
          payload.kind === "remove_agent"
        ) {
          log.error("pg-side effect failed — proposal stays open for retry", serializeError(error));
          return null;
        }
        status = "rejected";
        finalResolution = {
          outcome: "rejected",
          vetoedBy: null,
          reason: `approved but could not be applied: ${error instanceof Error ? error.message : String(error)}`,
        };
        doc.transact(() => {
          setProposalStatus(doc, proposal.id, "rejected");
          appendMessage(doc, {
            id: newId("message"),
            role: "system",
            authorId: "system",
            name: "Quorum",
            content: `Proposal "${proposal.title}" was approved but could not be applied: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
            createdAt: now,
            mentions: [],
          });
        }, CONSENSUS_ORIGIN);
        log.warn("approved proposal could not be applied", serializeError(error));
      }
    }

    log.info("proposal resolved", { status, reason: finalResolution.reason });

    try {
      await this.deps.audit.recordResolution({
        boardId,
        proposal,
        status,
        resolution: finalResolution,
        votes: votes.map((vote) => ({ memberId: vote.memberId, value: vote.value, at: vote.at })),
        resolvedAt: new Date(now),
      });
    } catch (error) {
      // The doc already carries the resolution (live truth); losing the audit
      // row is an operational incident, so log it as loudly as possible.
      log.error("FAILED TO AUDIT PROPOSAL RESOLUTION", serializeError(error));
    }
    return status;
  }
}
