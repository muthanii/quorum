/**
 * The pure consensus state machine — the product's differentiator (CLAUDE.md §6).
 *
 * `(proposal, votes, policy, activeMemberIds, now) => Resolution` with no I/O,
 * no clocks, no React, no Yjs. The ws server runs this authoritatively; the
 * web client runs the same function for optimistic display. Determinism is a
 * hard requirement: the same inputs (in any vote order) always produce the
 * same resolution.
 *
 * Pinned semantics implemented here (build brief "Consensus semantics"):
 * - Expiry wins first: the instant now >= expiresAt the proposal is expired
 *   (onTimeout is always "reject" — never auto-approve).
 * - Votes from inactive members are ignored in tallies but not discarded by
 *   callers — they count again when the member rejoins the active quorum.
 * - vetoIsFinal: any reject from a *binding* voter resolves rejected
 *   immediately. Under owner_only only the owner is binding, so non-owner
 *   rejects never veto.
 * - unanimous: every active member must have voted approve. Abstain is not
 *   approve; all-abstain stays open until timeout. With vetoIsFinal=false a
 *   reject leaves the proposal open (the member may change their vote).
 * - autoApproveOwnProposals=false: a human proposer is an ordinary required
 *   voter. When true, an implicit approve is synthesized for a human proposer
 *   unless they cast an explicit vote (an explicit vote always wins).
 * - Agent proposers and viewers have no vote. Zero active voters → open.
 * - majority: strictly more than half of active members must approve;
 *   non-voters count in the denominator. Evaluated eagerly: approved the
 *   moment approvals clear the bar; with vetoIsFinal=false, rejected the
 *   moment standing rejects make the bar unreachable.
 * - owner_only: only the owner's vote decides; others' votes are recorded but
 *   non-binding. Owner inactive or unknown → stays open.
 * - threshold:N — N approvals among *active* members. If N exceeds the active
 *   count the proposal cannot pass and stays open until timeout (it is never
 *   converted to unanimity, and never eagerly rejected).
 */
import type { ConsensusPolicy } from "../schemas/policy";
import type { VoteValue } from "../schemas/vote";
import type { EngineVote, Resolution, ResolveProposalInput } from "./types";

/** Exact-`at` tie-break: never let a timestamp tie accidentally approve. */
const CONSERVATIVENESS: Record<VoteValue, number> = { approve: 0, abstain: 1, reject: 2 };

export function resolveProposal(input: ResolveProposalInput): Resolution {
  const { proposal, votes, policy, now, ownerMemberId } = input;

  if (now >= proposal.expiresAt) {
    return {
      outcome: "expired",
      reason: `proposal expired at ${proposal.expiresAt} (onTimeout is "reject" — never auto-approve)`,
    };
  }

  // Dedupe active ids, preserving caller order so output arrays are stable.
  const active: string[] = [];
  const activeSet = new Set<string>();
  for (const id of input.activeMemberIds) {
    if (!activeSet.has(id)) {
      activeSet.add(id);
      active.push(id);
    }
  }

  const effective = effectiveVotes(votes, activeSet);

  if (
    policy.autoApproveOwnProposals &&
    proposal.authorKind === "human" &&
    activeSet.has(proposal.authorId) &&
    !effective.has(proposal.authorId)
  ) {
    effective.set(proposal.authorId, {
      memberId: proposal.authorId,
      value: "approve",
      at: proposal.createdAt,
    });
  }

  // Binding voters: whose approve/reject can actually move the resolution.
  const binding =
    policy.rule === "owner_only"
      ? ownerMemberId !== undefined && activeSet.has(ownerMemberId)
        ? [ownerMemberId]
        : []
      : active;

  const approvers = binding.filter((id) => effective.get(id)?.value === "approve");
  const rejecters = binding.filter((id) => effective.get(id)?.value === "reject");

  if (policy.vetoIsFinal && rejecters.length > 0) {
    const vetoer = pickVetoer(rejecters, effective);
    return {
      outcome: "rejected",
      vetoedBy: vetoer,
      reason: `vetoed by ${vetoer} — one reject resolves immediately (vetoIsFinal)`,
    };
  }

  switch (policy.rule) {
    case "unanimous":
      return resolveUnanimous(active, effective, approvers);
    case "majority":
      return resolveMajority(active, effective, approvers, rejecters, policy);
    case "owner_only":
      return resolveOwnerOnly(activeSet, effective, ownerMemberId);
    case "threshold":
      return resolveThreshold(active, effective, approvers, policy);
  }
}

function resolveUnanimous(
  active: readonly string[],
  effective: ReadonlyMap<string, EngineVote>,
  approvers: string[],
): Resolution {
  if (active.length === 0) {
    return open(
      [],
      "no active members — the proposal stays open until quorum returns or it expires",
    );
  }
  if (approvers.length === active.length) {
    return {
      outcome: "approved",
      approvedBy: approvers,
      reason: `unanimous: all ${active.length} active members approved`,
    };
  }
  const waitingOn = active.filter((id) => effective.get(id)?.value !== "approve");
  return open(
    waitingOn,
    `unanimous: ${approvers.length} of ${active.length} active members approved — abstain does not count as approve`,
  );
}

function resolveMajority(
  active: readonly string[],
  effective: ReadonlyMap<string, EngineVote>,
  approvers: string[],
  rejecters: string[],
  policy: ConsensusPolicy,
): Resolution {
  const denominator = active.length;
  if (denominator === 0) {
    return open(
      [],
      "no active members — the proposal stays open until quorum returns or it expires",
    );
  }
  const needed = Math.floor(denominator / 2) + 1;
  if (approvers.length >= needed) {
    return {
      outcome: "approved",
      approvedBy: approvers,
      reason: `majority: ${approvers.length} of ${denominator} active members approved (needed ${needed})`,
    };
  }
  // Only reachable with vetoIsFinal=false — otherwise any reject already vetoed.
  if (!policy.vetoIsFinal && denominator - rejecters.length < needed) {
    return {
      outcome: "rejected",
      vetoedBy: null,
      reason: `majority impossible: ${rejecters.length} of ${denominator} active members rejected, so at most ${denominator - rejecters.length} could approve (needed ${needed})`,
    };
  }
  return open(
    undecided(active, effective),
    `majority: ${approvers.length} of ${needed} needed approvals from ${denominator} active members`,
  );
}

function resolveOwnerOnly(
  activeSet: ReadonlySet<string>,
  effective: ReadonlyMap<string, EngineVote>,
  ownerMemberId: string | undefined,
): Resolution {
  if (ownerMemberId === undefined) {
    return open([], 'rule "owner_only" but no ownerMemberId was provided — cannot resolve');
  }
  if (!activeSet.has(ownerMemberId)) {
    return open([], `owner ${ownerMemberId} is not in the active quorum — waiting for the owner`);
  }
  const ownerVote = effective.get(ownerMemberId)?.value;
  if (ownerVote === "approve") {
    return {
      outcome: "approved",
      approvedBy: [ownerMemberId],
      reason: "owner approved (owner_only — non-owner votes are recorded but non-binding)",
    };
  }
  if (ownerVote === "reject") {
    return {
      outcome: "rejected",
      vetoedBy: ownerMemberId,
      reason: "owner rejected (owner_only — non-owner votes are recorded but non-binding)",
    };
  }
  return open(
    [ownerMemberId],
    "waiting on the owner's approve/reject (owner_only — abstain and non-owner votes do not decide)",
  );
}

function resolveThreshold(
  active: readonly string[],
  effective: ReadonlyMap<string, EngineVote>,
  approvers: string[],
  policy: ConsensusPolicy,
): Resolution {
  const n = policy.thresholdN;
  if (n === undefined) {
    return open([], 'rule "threshold" but thresholdN is missing — cannot resolve');
  }
  if (active.length === 0) {
    return open(
      [],
      "no active members — the proposal stays open until quorum returns or it expires",
    );
  }
  if (approvers.length >= n) {
    return {
      outcome: "approved",
      approvedBy: approvers,
      reason: `threshold: ${approvers.length} approvals from active members reached the required ${n}`,
    };
  }
  const waitingOn = undecided(active, effective);
  if (n > active.length) {
    return open(
      waitingOn,
      `threshold ${n} exceeds the ${active.length} active members — cannot pass until more members are active (stays open until timeout)`,
    );
  }
  return open(
    waitingOn,
    `threshold: ${approvers.length} of ${n} required approvals from ${active.length} active members`,
  );
}

/**
 * Latest vote per *active* member. Ties on `at` pick the more conservative
 * value so the result is order-independent and never accidentally approves.
 */
function effectiveVotes(
  votes: readonly EngineVote[],
  activeSet: ReadonlySet<string>,
): Map<string, EngineVote> {
  const latest = new Map<string, EngineVote>();
  for (const vote of votes) {
    if (!activeSet.has(vote.memberId)) continue;
    const prev = latest.get(vote.memberId);
    if (
      prev === undefined ||
      vote.at > prev.at ||
      (vote.at === prev.at && CONSERVATIVENESS[vote.value] > CONSERVATIVENESS[prev.value])
    ) {
      latest.set(vote.memberId, vote);
    }
  }
  return latest;
}

/** Earliest reject wins attribution; exact-`at` ties break on member id. */
function pickVetoer(
  rejecters: readonly string[],
  effective: ReadonlyMap<string, EngineVote>,
): string {
  let best: string | undefined;
  let bestAt = Infinity;
  for (const id of rejecters) {
    const at = effective.get(id)?.at ?? Infinity;
    if (best === undefined || at < bestAt || (at === bestAt && id < best)) {
      best = id;
      bestAt = at;
    }
  }
  if (best === undefined) throw new Error("pickVetoer called with no rejecters");
  return best;
}

/** Active members with no standing approve/reject — the ones a vote from could still move things. */
function undecided(
  active: readonly string[],
  effective: ReadonlyMap<string, EngineVote>,
): string[] {
  return active.filter((id) => {
    const value = effective.get(id)?.value;
    return value !== "approve" && value !== "reject";
  });
}

function open(waitingOn: string[], reason: string): Resolution {
  return { outcome: "open", waitingOn, reason };
}
