import { describe, expect, it } from "vitest";

import { resolveProposal } from "../../src/consensus/engine";
import type {
  EngineProposal,
  EngineVote,
  Resolution,
  ResolveProposalInput,
} from "../../src/consensus/types";
import { DEFAULT_POLICY, type ConsensusPolicy } from "../../src/schemas/policy";

const T0 = 1_000_000;
const EXPIRES = T0 + DEFAULT_POLICY.timeoutMs;

const ALICE = "mem_alice";
const BOB = "mem_bob";
const CARA = "mem_cara";
const DANA = "mem_dana";
const EVAN = "mem_evan";

const MAJORITY: ConsensusPolicy = { ...DEFAULT_POLICY, rule: "majority" };
const MAJORITY_NO_VETO: ConsensusPolicy = { ...MAJORITY, vetoIsFinal: false };
const OWNER_ONLY: ConsensusPolicy = { ...DEFAULT_POLICY, rule: "owner_only" };

function threshold(n: number, overrides: Partial<ConsensusPolicy> = {}): ConsensusPolicy {
  return { ...DEFAULT_POLICY, rule: "threshold", thresholdN: n, ...overrides };
}

function makeProposal(overrides: Partial<EngineProposal> = {}): EngineProposal {
  return {
    id: "prp_test0000000000",
    authorId: ALICE,
    authorKind: "human",
    createdAt: T0,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

function vote(memberId: string, value: EngineVote["value"], at = T0 + 1): EngineVote {
  return { memberId, value, at };
}

function resolve(overrides: Partial<ResolveProposalInput> = {}): Resolution {
  return resolveProposal({
    proposal: makeProposal(),
    votes: [],
    policy: DEFAULT_POLICY,
    activeMemberIds: [ALICE, BOB, CARA],
    now: T0 + 10,
    ...overrides,
  });
}

describe("timeout expiry", () => {
  it("expires exactly at the expiresAt boundary (now === expiresAt)", () => {
    const result = resolve({ now: EXPIRES });
    expect(result.outcome).toBe("expired");
  });

  it("is still open one millisecond before expiresAt", () => {
    const result = resolve({ now: EXPIRES - 1 });
    expect(result.outcome).toBe("open");
  });

  it("expires any time after expiresAt", () => {
    expect(resolve({ now: EXPIRES + 60_000 }).outcome).toBe("expired");
  });

  it("expiry wins over votes evaluated late — never auto-approve after timeout", () => {
    const result = resolve({
      votes: [vote(ALICE, "approve"), vote(BOB, "approve"), vote(CARA, "approve")],
      now: EXPIRES,
    });
    expect(result.outcome).toBe("expired");
    if (result.outcome === "expired") {
      expect(result.reason).toContain("never auto-approve");
    }
  });

  it("all-abstain stays open until timeout, then expires (never approves)", () => {
    const votes = [vote(ALICE, "abstain"), vote(BOB, "abstain"), vote(CARA, "abstain")];
    expect(resolve({ votes, now: EXPIRES - 1 }).outcome).toBe("open");
    expect(resolve({ votes, now: EXPIRES }).outcome).toBe("expired");
  });
});

describe("unanimous (default policy)", () => {
  it("approves when every active member approved", () => {
    const result = resolve({
      votes: [vote(ALICE, "approve"), vote(BOB, "approve"), vote(CARA, "approve")],
    });
    expect(result).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB, CARA] });
  });

  it("stays open while any active member has not approved", () => {
    const result = resolve({ votes: [vote(ALICE, "approve"), vote(BOB, "approve")] });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [CARA] });
  });

  it("abstain never counts as approve", () => {
    const result = resolve({
      votes: [vote(ALICE, "approve"), vote(BOB, "approve"), vote(CARA, "abstain")],
    });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [CARA] });
  });

  it("a single veto resolves rejected immediately, before others vote", () => {
    const result = resolve({ votes: [vote(BOB, "reject")] });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: BOB });
  });

  it("a veto wins even when everyone else approved", () => {
    const result = resolve({
      votes: [vote(ALICE, "approve"), vote(BOB, "approve"), vote(CARA, "reject")],
    });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: CARA });
  });

  it("with several rejects the earliest one is attributed as the vetoer", () => {
    const result = resolve({
      votes: [vote(CARA, "reject", T0 + 5), vote(BOB, "reject", T0 + 2)],
    });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: BOB });
  });

  it("zero active members stays open (never resolves without a quorum)", () => {
    const result = resolve({ activeMemberIds: [], votes: [vote(ALICE, "approve")] });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [] });
  });

  it("with vetoIsFinal=false a reject leaves the proposal open (member may change their mind)", () => {
    const noVeto: ConsensusPolicy = { ...DEFAULT_POLICY, vetoIsFinal: false };
    const result = resolve({
      policy: noVeto,
      votes: [vote(ALICE, "approve"), vote(BOB, "approve"), vote(CARA, "reject")],
    });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [CARA] });

    const flipped = resolve({
      policy: noVeto,
      votes: [
        vote(ALICE, "approve"),
        vote(BOB, "approve"),
        vote(CARA, "reject", T0 + 2),
        vote(CARA, "approve", T0 + 3),
      ],
    });
    expect(flipped.outcome).toBe("approved");
  });
});

describe("vote mutation and duplicates", () => {
  it("the latest vote per member wins (approve then reject → veto)", () => {
    const result = resolve({
      votes: [vote(ALICE, "approve", T0 + 1), vote(ALICE, "reject", T0 + 2)],
    });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: ALICE });
  });

  it("the latest vote per member wins (reject then approve → no veto)", () => {
    const result = resolve({
      votes: [
        vote(ALICE, "reject", T0 + 1),
        vote(ALICE, "approve", T0 + 2),
        vote(BOB, "approve"),
        vote(CARA, "approve"),
      ],
    });
    expect(result.outcome).toBe("approved");
  });

  it("an exact-timestamp tie resolves to the more conservative value (never accidentally approves)", () => {
    const result = resolve({
      votes: [
        vote(ALICE, "approve", T0 + 5),
        vote(ALICE, "reject", T0 + 5),
        vote(BOB, "approve"),
        vote(CARA, "approve"),
      ],
    });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: ALICE });
  });
});

describe("proposer semantics", () => {
  it("autoApproveOwnProposals=false: the proposer must still explicitly approve", () => {
    const result = resolve({ votes: [vote(BOB, "approve"), vote(CARA, "approve")] });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [ALICE] });
  });

  it("autoApproveOwnProposals=false: proposer's explicit approve completes unanimity", () => {
    const result = resolve({
      votes: [vote(BOB, "approve"), vote(CARA, "approve"), vote(ALICE, "approve")],
    });
    expect(result.outcome).toBe("approved");
  });

  it("autoApproveOwnProposals=true: a human proposer's approve is implicit", () => {
    const result = resolve({
      policy: { ...DEFAULT_POLICY, autoApproveOwnProposals: true },
      votes: [vote(BOB, "approve"), vote(CARA, "approve")],
    });
    expect(result).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB, CARA] });
  });

  it("autoApproveOwnProposals=true: an explicit vote from the proposer overrides the implicit approve", () => {
    const result = resolve({
      policy: { ...DEFAULT_POLICY, autoApproveOwnProposals: true },
      votes: [vote(BOB, "approve"), vote(CARA, "approve"), vote(ALICE, "reject")],
    });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: ALICE });
  });

  it("autoApproveOwnProposals=true: no vote is synthesized for a proposer outside the active quorum", () => {
    // Alice proposed then went inactive — Bob and Cara alone form the quorum,
    // and their unanimity passes without any phantom approve from Alice.
    const votes = [vote(BOB, "approve")];
    const policy = { ...DEFAULT_POLICY, autoApproveOwnProposals: true };
    expect(resolve({ policy, activeMemberIds: [BOB, CARA], votes })).toMatchObject({
      outcome: "open",
      waitingOn: [CARA],
    });
    expect(
      resolve({ policy, activeMemberIds: [BOB, CARA], votes: [...votes, vote(CARA, "approve")] }),
    ).toMatchObject({ outcome: "approved", approvedBy: [BOB, CARA] });
  });

  it("agent proposers have no vote: unanimity is over active humans only", () => {
    const result = resolve({
      proposal: makeProposal({ authorId: "agt_researcher123", authorKind: "agent" }),
      votes: [vote(ALICE, "approve"), vote(BOB, "approve"), vote(CARA, "approve")],
    });
    expect(result).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB, CARA] });
  });

  it("autoApproveOwnProposals=true never synthesizes a vote for an agent author", () => {
    const result = resolve({
      proposal: makeProposal({ authorId: "agt_researcher123", authorKind: "agent" }),
      policy: { ...DEFAULT_POLICY, autoApproveOwnProposals: true },
      votes: [vote(ALICE, "approve"), vote(BOB, "approve")],
    });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [CARA] });
  });
});

describe("active-quorum membership changes", () => {
  it("ignores votes from members no longer active", () => {
    const result = resolve({
      activeMemberIds: [ALICE, BOB],
      votes: [vote(ALICE, "approve"), vote(BOB, "approve"), vote(CARA, "reject")],
    });
    // Cara's reject would veto — but she is not active, so it does not count.
    expect(result.outcome).toBe("approved");
  });

  it("member disconnect mid-vote: a previously-blocked proposal approves on re-evaluation", () => {
    const votes = [vote(ALICE, "approve"), vote(BOB, "approve")];
    const before = resolve({ activeMemberIds: [ALICE, BOB, CARA], votes });
    expect(before).toMatchObject({ outcome: "open", waitingOn: [CARA] });

    const after = resolve({ activeMemberIds: [ALICE, BOB], votes });
    expect(after).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB] });
  });

  it("member rejoin: their stale vote counts again (approve)", () => {
    const votes = [vote(CARA, "approve", T0 + 1), vote(ALICE, "approve"), vote(BOB, "approve")];
    // Cara approved, then went inactive: her vote is ignored but kept.
    expect(resolve({ activeMemberIds: [ALICE, BOB], votes }).outcome).toBe("approved");
    // She rejoins: same votes, her stale approve completes 3-way unanimity.
    const rejoined = resolve({ activeMemberIds: [ALICE, BOB, CARA], votes });
    expect(rejoined).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB, CARA] });
  });

  it("member rejoin: their stale reject vetoes again", () => {
    const votes = [vote(CARA, "reject", T0 + 1), vote(ALICE, "approve"), vote(BOB, "approve")];
    expect(resolve({ activeMemberIds: [ALICE, BOB], votes }).outcome).toBe("approved");
    const rejoined = resolve({ activeMemberIds: [ALICE, BOB, CARA], votes });
    expect(rejoined).toMatchObject({ outcome: "rejected", vetoedBy: CARA });
  });

  it("deduplicates repeated ids in activeMemberIds", () => {
    const result = resolve({
      activeMemberIds: [ALICE, ALICE, BOB],
      votes: [vote(ALICE, "approve"), vote(BOB, "approve")],
    });
    expect(result).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB] });
  });
});

describe("majority", () => {
  it("approves eagerly the moment approvals exceed half of active members", () => {
    const result = resolve({
      policy: MAJORITY,
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [vote(ALICE, "approve"), vote(BOB, "approve")],
    });
    expect(result).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB] });
  });

  it("requires strictly more than half — an even split of approvals stays open", () => {
    const result = resolve({
      policy: MAJORITY,
      activeMemberIds: [ALICE, BOB, CARA, DANA],
      votes: [vote(ALICE, "approve"), vote(BOB, "approve")],
    });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [CARA, DANA] });
  });

  it("non-voters count in the denominator", () => {
    const result = resolve({
      policy: MAJORITY,
      activeMemberIds: [ALICE, BOB, CARA, DANA, EVAN],
      votes: [vote(ALICE, "approve"), vote(BOB, "approve")],
    });
    // 2 of 5 — needs 3 even though only 2 have voted.
    expect(result.outcome).toBe("open");
  });

  it("with vetoIsFinal=true (default) a single reject still vetoes under majority", () => {
    const result = resolve({
      policy: MAJORITY,
      activeMemberIds: [ALICE, BOB, CARA, DANA, EVAN],
      votes: [vote(ALICE, "approve"), vote(BOB, "reject"), vote(CARA, "approve")],
    });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: BOB });
  });

  it("with vetoIsFinal=false the vote continues past a reject and can still approve", () => {
    const result = resolve({
      policy: MAJORITY_NO_VETO,
      activeMemberIds: [ALICE, BOB, CARA, DANA, EVAN],
      votes: [
        vote(BOB, "reject", T0 + 1),
        vote(ALICE, "approve", T0 + 2),
        vote(CARA, "approve", T0 + 3),
        vote(DANA, "approve", T0 + 4),
      ],
    });
    expect(result).toMatchObject({ outcome: "approved", approvedBy: [ALICE, CARA, DANA] });
  });

  it("with vetoIsFinal=false it rejects once standing rejects make approval impossible", () => {
    const result = resolve({
      policy: MAJORITY_NO_VETO,
      activeMemberIds: [ALICE, BOB, CARA, DANA],
      votes: [vote(ALICE, "reject"), vote(BOB, "reject")],
    });
    // At most 2 of 4 could approve; 3 are needed.
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: null });
  });

  it("with vetoIsFinal=false a reject that does not make approval impossible stays open", () => {
    const result = resolve({
      policy: MAJORITY_NO_VETO,
      activeMemberIds: [ALICE, BOB, CARA, DANA],
      votes: [vote(ALICE, "reject"), vote(BOB, "approve")],
    });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [CARA, DANA] });
  });

  it("zero active members stays open", () => {
    expect(resolve({ policy: MAJORITY, activeMemberIds: [] }).outcome).toBe("open");
  });
});

describe("owner_only", () => {
  const withOwner = (overrides: Partial<ResolveProposalInput> = {}) =>
    resolve({ policy: OWNER_ONLY, ownerMemberId: ALICE, ...overrides });

  it("owner's approve resolves approved", () => {
    const result = withOwner({ votes: [vote(ALICE, "approve")] });
    expect(result).toMatchObject({ outcome: "approved", approvedBy: [ALICE] });
  });

  it("owner's reject resolves rejected", () => {
    const result = withOwner({ votes: [vote(ALICE, "reject")] });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: ALICE });
  });

  it("owner's reject resolves rejected even with vetoIsFinal=false — the owner decides", () => {
    const result = withOwner({
      policy: { ...OWNER_ONLY, vetoIsFinal: false },
      votes: [vote(ALICE, "reject")],
    });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: ALICE });
  });

  it("non-owner rejects never veto, even with vetoIsFinal=true", () => {
    const result = withOwner({ votes: [vote(BOB, "reject"), vote(CARA, "reject")] });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [ALICE] });
  });

  it("non-owner approvals never approve", () => {
    const result = withOwner({ votes: [vote(BOB, "approve"), vote(CARA, "approve")] });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [ALICE] });
  });

  it("owner abstain does not decide — stays open waiting on the owner", () => {
    const result = withOwner({ votes: [vote(ALICE, "abstain")] });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [ALICE] });
  });

  it("owner not in the active quorum → stays open (their stale vote does not count)", () => {
    const result = withOwner({
      activeMemberIds: [BOB, CARA],
      votes: [vote(ALICE, "approve")],
    });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [] });
  });

  it("missing ownerMemberId → stays open (cannot resolve)", () => {
    const result = resolve({ policy: OWNER_ONLY, votes: [vote(ALICE, "approve")] });
    expect(result.outcome).toBe("open");
  });

  it("still expires at timeout while waiting on the owner", () => {
    const result = withOwner({ votes: [vote(BOB, "approve")], now: EXPIRES });
    expect(result.outcome).toBe("expired");
  });
});

describe("threshold:N", () => {
  it("approves once N active members approved, before the rest vote", () => {
    const result = resolve({
      policy: threshold(2),
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [vote(ALICE, "approve"), vote(BOB, "approve")],
    });
    expect(result).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB] });
  });

  it("N greater than the active count cannot pass — even with every active member approving", () => {
    const result = resolve({
      policy: threshold(3),
      activeMemberIds: [ALICE, BOB],
      votes: [vote(ALICE, "approve"), vote(BOB, "approve")],
    });
    expect(result.outcome).toBe("open");
    if (result.outcome === "open") {
      expect(result.reason).toContain("cannot pass");
    }
  });

  it("N greater than the active count stays open until timeout, then expires", () => {
    const input: Partial<ResolveProposalInput> = {
      policy: threshold(3),
      activeMemberIds: [ALICE, BOB],
      votes: [vote(ALICE, "approve"), vote(BOB, "approve")],
    };
    expect(resolve({ ...input, now: EXPIRES - 1 }).outcome).toBe("open");
    expect(resolve({ ...input, now: EXPIRES }).outcome).toBe("expired");
  });

  it("approvals from inactive members do not count toward N — until they rejoin", () => {
    const votes = [vote(ALICE, "approve"), vote(BOB, "approve")];
    const blocked = resolve({ policy: threshold(2), activeMemberIds: [ALICE], votes });
    expect(blocked.outcome).toBe("open");

    const rejoined = resolve({ policy: threshold(2), activeMemberIds: [ALICE, BOB], votes });
    expect(rejoined).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB] });
  });

  it("a reject vetoes under the default vetoIsFinal=true", () => {
    const result = resolve({
      policy: threshold(2),
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [vote(ALICE, "approve"), vote(BOB, "reject")],
    });
    expect(result).toMatchObject({ outcome: "rejected", vetoedBy: BOB });
  });

  it("with vetoIsFinal=false rejects leave a threshold proposal open (no eager impossibility)", () => {
    const result = resolve({
      policy: threshold(2, { vetoIsFinal: false }),
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [vote(ALICE, "approve"), vote(BOB, "reject"), vote(CARA, "reject")],
    });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [] });
  });

  it("zero active members stays open", () => {
    expect(resolve({ policy: threshold(1), activeMemberIds: [] }).outcome).toBe("open");
  });

  it("a threshold policy missing thresholdN cannot resolve — stays open", () => {
    const broken = { ...DEFAULT_POLICY, rule: "threshold" as const };
    const result = resolve({
      policy: broken,
      votes: [vote(ALICE, "approve"), vote(BOB, "approve"), vote(CARA, "approve")],
    });
    expect(result.outcome).toBe("open");
  });
});

describe("policy change during an open proposal", () => {
  const votes = [vote(ALICE, "approve"), vote(BOB, "approve")];
  const active = [ALICE, BOB, CARA];

  it("the same votes re-evaluate under the new policy from that moment", () => {
    const underUnanimous = resolve({ policy: DEFAULT_POLICY, activeMemberIds: active, votes });
    expect(underUnanimous).toMatchObject({ outcome: "open", waitingOn: [CARA] });

    const underMajority = resolve({ policy: MAJORITY, activeMemberIds: active, votes });
    expect(underMajority).toMatchObject({ outcome: "approved", approvedBy: [ALICE, BOB] });
  });

  it("tightening the policy re-blocks a proposal a looser rule would pass", () => {
    const underThreshold = resolve({ policy: threshold(2), activeMemberIds: active, votes });
    expect(underThreshold.outcome).toBe("approved");

    const backToUnanimous = resolve({ policy: DEFAULT_POLICY, activeMemberIds: active, votes });
    expect(backToUnanimous.outcome).toBe("open");
  });

  it("switching to owner_only makes only the owner's vote matter", () => {
    const result = resolve({
      policy: OWNER_ONLY,
      activeMemberIds: active,
      votes,
      ownerMemberId: CARA,
    });
    expect(result).toMatchObject({ outcome: "open", waitingOn: [CARA] });
  });
});
