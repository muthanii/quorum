/**
 * Pure view-model for a proposal's vote UI — chips, tally, countdown, and an
 * optimistic outcome preview. Pure derivation only: no I/O, no React, no
 * clocks. The consensus ENGINE stays in @quorum/shared/consensus — this file
 * only projects its output (plus the raw votes) into render-ready data. The
 * ws server remains the sole authority on actual resolution.
 *
 * Id space: `members[].id`, `activeMemberIds`, vote keys, and a human
 * proposal's authorId must all share one id space. Web-side that space is
 * the usr_ id (the ws token `sub`); the engine itself is agnostic.
 */
import { colorForUser } from "@quorum/shared/colors";
import { resolveProposal } from "@quorum/shared/consensus/engine";
import type { EngineVote, Resolution } from "@quorum/shared/consensus/types";
import type { MemberRole } from "@quorum/shared/schemas/member";
import type { ConsensusPolicy } from "@quorum/shared/schemas/policy";
import type { Proposal } from "@quorum/shared/schemas/proposal";
import type { VoteEntry, VoteValue } from "@quorum/shared/schemas/vote";

export interface VoteMemberInfo {
  id: string;
  name: string;
  role: MemberRole;
  /** Identity color; defaults to colorForUser(id) when omitted. */
  color?: string;
}

export interface VoteChip {
  memberId: string;
  name: string;
  color: string;
  value: VoteValue | "pending";
  /**
   * Whether this member currently counts toward the quorum. The UI shows
   * quorum recalculation (a member dropping out) instead of silently
   * changing the threshold (CLAUDE.md §6).
   */
  active: boolean;
}

export interface VoteTally {
  /** Approvals from currently-active members. */
  approved: number;
  /** Approvals required under the current policy and active quorum. */
  needed: number;
  /** Size of the active voting quorum. */
  total: number;
}

export interface VoteViewModel {
  chips: VoteChip[];
  tally: VoteTally;
  /** Names of active members whose vote is still awaited (empty unless open). */
  waitingOnNames: string[];
  /** The engine's optimistic resolution — display only, never applied here. */
  outcomePreview: Resolution;
  /** True when the local member can cast or change a vote right now. */
  canVote: boolean;
  /** Clamped to 0 once expired. */
  msRemaining: number;
}

export interface VoteStateInput {
  proposal: Proposal;
  /** memberId → vote, exactly as read from the proposal's votes Y.Map. */
  votes: Record<string, VoteEntry>;
  members: readonly VoteMemberInfo[];
  /** From activeMemberIds() in @quorum/shared — viewers already excluded. */
  activeMemberIds: readonly string[];
  policy: ConsensusPolicy;
  /** Unix epoch ms — injected, never Date.now() in here. */
  now: number;
  /** The local member's id; null/undefined for read-only contexts. */
  selfMemberId?: string | null;
  /** Required for rule "owner_only" to ever resolve. */
  ownerMemberId?: string;
}

function neededApprovals(policy: ConsensusPolicy, activeCount: number): number {
  switch (policy.rule) {
    case "unanimous":
      return activeCount;
    case "majority":
      return activeCount === 0 ? 0 : Math.floor(activeCount / 2) + 1;
    case "owner_only":
      return 1;
    case "threshold":
      // The schema guarantees thresholdN for this rule; 0 is a defensive
      // fallback for unparsed policies, never a real target.
      return policy.thresholdN ?? 0;
  }
}

export function buildVoteState(input: VoteStateInput): VoteViewModel {
  const { proposal, votes, members, policy, now } = input;

  const activeSet = new Set(input.activeMemberIds);

  const engineVotes: EngineVote[] = Object.entries(votes).map(([memberId, vote]) => ({
    memberId,
    value: vote.value,
    at: vote.at,
  }));

  const outcomePreview = resolveProposal({
    proposal: {
      id: proposal.id,
      authorId: proposal.authorId,
      authorKind: proposal.authorKind,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
    },
    votes: engineVotes,
    policy,
    activeMemberIds: input.activeMemberIds,
    now,
    ...(input.ownerMemberId !== undefined ? { ownerMemberId: input.ownerMemberId } : {}),
  });

  // Chips: every potential voter (viewers never vote), including currently
  // inactive ones — their standing vote is kept and re-counts on rejoin.
  const chips: VoteChip[] = members
    .filter((member) => member.role !== "viewer")
    .map((member) => ({
      memberId: member.id,
      name: member.name,
      color: member.color ?? colorForUser(member.id),
      value: votes[member.id]?.value ?? "pending",
      active: activeSet.has(member.id),
    }));

  const total = activeSet.size;
  let approved = 0;
  for (const id of activeSet) {
    if (votes[id]?.value === "approve") approved += 1;
  }

  const nameById = new Map(members.map((member) => [member.id, member.name]));
  const waitingOnNames =
    outcomePreview.outcome === "open"
      ? outcomePreview.waitingOn.map((id) => nameById.get(id) ?? id)
      : [];

  const selfId = input.selfMemberId ?? null;
  const self = selfId === null ? undefined : members.find((member) => member.id === selfId);
  const canVote =
    self !== undefined &&
    self.role !== "viewer" &&
    activeSet.has(self.id) &&
    proposal.status === "open" &&
    outcomePreview.outcome === "open";

  return {
    chips,
    tally: { approved, needed: neededApprovals(policy, total), total },
    waitingOnNames,
    outcomePreview,
    canVote,
    msRemaining: Math.max(0, proposal.expiresAt - now),
  };
}
