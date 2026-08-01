/**
 * Input/output types for the pure consensus state machine (engine.ts).
 *
 * These are deliberately narrower than the full `Proposal` / `Vote` schemas:
 * the engine only needs identity, timing, and authorship — callers (ws server,
 * web view-models) project their richer records down to these shapes.
 */
import type { ConsensusPolicy } from "../schemas/policy";
import type { ProposalAuthorKind } from "../schemas/proposal";
import type { VoteValue } from "../schemas/vote";

export interface EngineProposal {
  id: string;
  /**
   * For human proposals this MUST be the proposer's *member* id (mem_…) so the
   * engine can match it against `activeMemberIds` and vote keys — the caller
   * maps usr_ → mem_ before invoking the engine. For agent proposals it is the
   * agent id (agents never vote, so it never matches a member).
   */
  authorId: string;
  authorKind: ProposalAuthorKind;
  /** Unix epoch milliseconds. */
  createdAt: number;
  /** Unix epoch milliseconds — the proposal expires the instant now >= expiresAt. */
  expiresAt: number;
}

export interface EngineVote {
  memberId: string;
  value: VoteValue;
  /** Unix epoch milliseconds. */
  at: number;
}

export interface ResolveProposalInput {
  proposal: EngineProposal;
  /**
   * ALL recorded votes, including from currently-inactive members. Votes whose
   * member is not in `activeMemberIds` are ignored in tallies but must be kept
   * by the caller — they count again if the member rejoins. Multiple entries
   * per member are allowed; the latest `at` wins (exact-`at` ties resolve to
   * the more conservative value: reject > abstain > approve).
   */
  votes: readonly EngineVote[];
  policy: ConsensusPolicy;
  /**
   * The voting quorum: member ids that are connected now OR seen within the
   * active window, viewers already excluded (see quorum.ts). The engine never
   * reads clocks or presence itself.
   */
  activeMemberIds: readonly string[];
  /** Unix epoch milliseconds — injected, the engine never calls Date.now(). */
  now: number;
  /**
   * The board owner's member id. Required for rule "owner_only" (the pinned
   * five-field signature has no other slot for it); without it an owner_only
   * proposal can never resolve and stays open until timeout.
   */
  ownerMemberId?: string;
}

export type Resolution =
  | {
      outcome: "open";
      /** Active members whose vote is still awaited. Empty when nobody can currently move the proposal. */
      waitingOn: string[];
      reason: string;
    }
  | {
      outcome: "approved";
      /** The binding approvals that carried the decision, in activeMemberIds order. */
      approvedBy: string[];
      reason: string;
    }
  | {
      outcome: "rejected";
      /**
       * The member whose reject resolved the proposal (veto, or the owner under
       * owner_only). `null` when rejection is structural — e.g. majority became
       * arithmetically impossible with vetoIsFinal=false.
       */
      vetoedBy: string | null;
      reason: string;
    }
  | { outcome: "expired"; reason: string };

export type ResolutionOutcome = Resolution["outcome"];
