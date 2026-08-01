import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, policySchema, type ConsensusPolicy } from "@quorum/shared/schemas/policy";
import type { Proposal } from "@quorum/shared/schemas/proposal";
import type { VoteEntry } from "@quorum/shared/schemas/vote";
import { colorForUser } from "@quorum/shared/colors";

import { buildVoteState, type VoteMemberInfo, type VoteStateInput } from "./vote-state";

const NOW = 1_700_000_000_000;

const alice: VoteMemberInfo = { id: "usr_alice00000000000", name: "Alice", role: "owner" };
const bob: VoteMemberInfo = { id: "usr_bob0000000000000", name: "Bob", role: "editor" };
const carol: VoteMemberInfo = { id: "usr_carol0000000000", name: "Carol", role: "editor" };
const vic: VoteMemberInfo = { id: "usr_vic0000000000000", name: "Vic", role: "viewer" };

const MEMBERS = [alice, bob, carol, vic];

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "prp_test000000000000",
    kind: "agent_prompt",
    title: "Ask the researcher",
    summary: "Prompt another agent",
    authorId: alice.id,
    authorKind: "human",
    createdAt: NOW - 60_000,
    expiresAt: NOW + 240_000,
    status: "open",
    payload: { kind: "agent_prompt", targetAgentId: "agt_target0000000000", content: "go" },
    affectedArtifactIds: [],
    ...overrides,
  };
}

function vote(value: VoteEntry["value"], at = NOW - 1000): VoteEntry {
  return { value, at };
}

function build(overrides: Partial<VoteStateInput> = {}) {
  return buildVoteState({
    proposal: makeProposal(),
    votes: {},
    members: MEMBERS,
    activeMemberIds: [alice.id, bob.id, carol.id],
    policy: DEFAULT_POLICY,
    now: NOW,
    selfMemberId: bob.id,
    ...overrides,
  });
}

describe("buildVoteState — chips", () => {
  it("renders one chip per non-viewer member; viewers never get a chip", () => {
    const state = build();
    expect(state.chips.map((c) => c.memberId)).toEqual([alice.id, bob.id, carol.id]);
    expect(state.chips.every((c) => c.memberId !== vic.id)).toBe(true);
  });

  it("shows pending for members who have not voted and the value for those who have", () => {
    const state = build({ votes: { [alice.id]: vote("approve"), [carol.id]: vote("abstain") } });
    const byId = new Map(state.chips.map((c) => [c.memberId, c]));
    expect(byId.get(alice.id)?.value).toBe("approve");
    expect(byId.get(bob.id)?.value).toBe("pending");
    expect(byId.get(carol.id)?.value).toBe("abstain");
  });

  it("defaults chip color to colorForUser and honors an explicit color", () => {
    const painted: VoteMemberInfo = { ...bob, color: "#123456" };
    const state = build({ members: [alice, painted] });
    const byId = new Map(state.chips.map((c) => [c.memberId, c]));
    expect(byId.get(alice.id)?.color).toBe(colorForUser(alice.id));
    expect(byId.get(bob.id)?.color).toBe("#123456");
  });

  it("marks inactive members' chips active:false while keeping their standing vote visible", () => {
    const state = build({
      activeMemberIds: [alice.id, bob.id],
      votes: { [carol.id]: vote("approve") },
    });
    const carolChip = state.chips.find((c) => c.memberId === carol.id);
    expect(carolChip).toMatchObject({ active: false, value: "approve" });
    // ...but the inactive approval does not count toward the tally.
    expect(state.tally).toEqual({ approved: 0, needed: 2, total: 2 });
  });
});

describe("buildVoteState — unanimous (default policy)", () => {
  it("stays open with everyone pending and lists all active members as waited on", () => {
    const state = build();
    expect(state.outcomePreview.outcome).toBe("open");
    expect(state.waitingOnNames.sort()).toEqual(["Alice", "Bob", "Carol"]);
    expect(state.tally).toEqual({ approved: 0, needed: 3, total: 3 });
  });

  it("previews approved when all active members approve", () => {
    const state = build({
      votes: {
        [alice.id]: vote("approve"),
        [bob.id]: vote("approve"),
        [carol.id]: vote("approve"),
      },
    });
    expect(state.outcomePreview.outcome).toBe("approved");
    expect(state.tally.approved).toBe(3);
    expect(state.waitingOnNames).toEqual([]);
  });

  it("previews rejected immediately on a single veto (vetoIsFinal)", () => {
    const state = build({
      votes: { [alice.id]: vote("approve"), [carol.id]: vote("reject") },
    });
    expect(state.outcomePreview.outcome).toBe("rejected");
    if (state.outcomePreview.outcome === "rejected") {
      expect(state.outcomePreview.vetoedBy).toBe(carol.id);
    }
    expect(state.canVote).toBe(false);
  });

  it("abstain never counts as approve — proposal stays open on all-abstain", () => {
    const state = build({
      votes: {
        [alice.id]: vote("abstain"),
        [bob.id]: vote("abstain"),
        [carol.id]: vote("abstain"),
      },
    });
    expect(state.outcomePreview.outcome).toBe("open");
    expect(state.tally.approved).toBe(0);
  });

  it("member disconnect mid-vote shrinks the quorum: remaining approvals then carry", () => {
    const votes = { [alice.id]: vote("approve"), [bob.id]: vote("approve") };
    const before = build({ votes });
    expect(before.outcomePreview.outcome).toBe("open");
    const after = build({ votes, activeMemberIds: [alice.id, bob.id] });
    expect(after.outcomePreview.outcome).toBe("approved");
    expect(after.tally).toEqual({ approved: 2, needed: 2, total: 2 });
  });

  it("member rejoin re-counts their standing vote", () => {
    const votes = { [carol.id]: vote("reject") };
    const away = build({ votes, activeMemberIds: [alice.id, bob.id] });
    expect(away.outcomePreview.outcome).toBe("open");
    const back = build({ votes, activeMemberIds: [alice.id, bob.id, carol.id] });
    expect(back.outcomePreview.outcome).toBe("rejected");
  });

  it("zero active members: stays open, tally is 0/0/0, nobody can vote", () => {
    const state = build({ activeMemberIds: [] });
    expect(state.outcomePreview.outcome).toBe("open");
    expect(state.tally).toEqual({ approved: 0, needed: 0, total: 0 });
    expect(state.canVote).toBe(false);
  });
});

describe("buildVoteState — expiry & countdown", () => {
  it("previews expired the instant now reaches expiresAt and clamps msRemaining to 0", () => {
    const proposal = makeProposal({ expiresAt: NOW });
    const state = build({ proposal });
    expect(state.outcomePreview.outcome).toBe("expired");
    expect(state.msRemaining).toBe(0);
    expect(state.canVote).toBe(false);
    expect(state.waitingOnNames).toEqual([]);
  });

  it("reports the remaining time while open", () => {
    const state = build({ proposal: makeProposal({ expiresAt: NOW + 90_000 }) });
    expect(state.msRemaining).toBe(90_000);
  });
});

describe("buildVoteState — majority", () => {
  const majority: ConsensusPolicy = policySchema.parse({ rule: "majority" });

  it("needs floor(n/2)+1 of active members and previews approved at the bar", () => {
    const state = build({
      policy: majority,
      votes: { [alice.id]: vote("approve"), [bob.id]: vote("approve") },
    });
    expect(state.tally).toEqual({ approved: 2, needed: 2, total: 3 });
    expect(state.outcomePreview.outcome).toBe("approved");
  });

  it("stays open below the bar", () => {
    const state = build({ policy: majority, votes: { [alice.id]: vote("approve") } });
    expect(state.outcomePreview.outcome).toBe("open");
    expect(state.tally.approved).toBe(1);
  });
});

describe("buildVoteState — threshold", () => {
  const threshold2: ConsensusPolicy = policySchema.parse({ rule: "threshold", thresholdN: 2 });

  it("needed comes from thresholdN", () => {
    const state = build({ policy: threshold2, votes: { [alice.id]: vote("approve") } });
    expect(state.tally.needed).toBe(2);
    expect(state.outcomePreview.outcome).toBe("open");
  });

  it("previews approved once N active approvals land", () => {
    const state = build({
      policy: threshold2,
      votes: { [alice.id]: vote("approve"), [carol.id]: vote("approve") },
    });
    expect(state.outcomePreview.outcome).toBe("approved");
  });

  it("threshold above the active count stays open (never converted, never rejected)", () => {
    const state = build({
      policy: policySchema.parse({ rule: "threshold", thresholdN: 5 }),
      votes: {
        [alice.id]: vote("approve"),
        [bob.id]: vote("approve"),
        [carol.id]: vote("approve"),
      },
    });
    expect(state.outcomePreview.outcome).toBe("open");
    expect(state.tally).toEqual({ approved: 3, needed: 5, total: 3 });
  });
});

describe("buildVoteState — owner_only", () => {
  const ownerOnly: ConsensusPolicy = policySchema.parse({ rule: "owner_only" });

  it("only the owner's approve decides; needed is 1", () => {
    const state = build({
      policy: ownerOnly,
      ownerMemberId: alice.id,
      votes: { [alice.id]: vote("approve") },
    });
    expect(state.tally.needed).toBe(1);
    expect(state.outcomePreview.outcome).toBe("approved");
  });

  it("non-owner votes are recorded but non-binding", () => {
    const state = build({
      policy: ownerOnly,
      ownerMemberId: alice.id,
      votes: { [bob.id]: vote("reject"), [carol.id]: vote("approve") },
    });
    expect(state.outcomePreview.outcome).toBe("open");
    expect(state.waitingOnNames).toEqual(["Alice"]);
  });

  it("without ownerMemberId the proposal cannot resolve and stays open", () => {
    const state = build({ policy: ownerOnly, votes: { [alice.id]: vote("approve") } });
    expect(state.outcomePreview.outcome).toBe("open");
  });
});

describe("buildVoteState — canVote", () => {
  it("true for an active non-viewer member on an open proposal (even after voting — votes can change)", () => {
    expect(build().canVote).toBe(true);
    expect(build({ votes: { [bob.id]: vote("approve") } }).canVote).toBe(true);
  });

  it("false for viewers", () => {
    expect(build({ selfMemberId: vic.id }).canVote).toBe(false);
  });

  it("false when self is not in the active quorum", () => {
    expect(build({ activeMemberIds: [alice.id, carol.id] }).canVote).toBe(false);
  });

  it("false for non-members and when no self is provided", () => {
    expect(build({ selfMemberId: "usr_stranger00000000" }).canVote).toBe(false);
    expect(build({ selfMemberId: null }).canVote).toBe(false);
  });

  it("false once the proposal status is resolved server-side", () => {
    expect(build({ proposal: makeProposal({ status: "applied" }) }).canVote).toBe(false);
    expect(build({ proposal: makeProposal({ status: "rejected" }) }).canVote).toBe(false);
  });

  it("false once the preview already resolved (e.g. veto landed) even if status is still open", () => {
    const state = build({ votes: { [alice.id]: vote("reject") } });
    expect(state.outcomePreview.outcome).toBe("rejected");
    expect(state.canVote).toBe(false);
  });
});

describe("buildVoteState — agent-authored proposals", () => {
  it("agent proposers have no vote: all humans must still approve", () => {
    const proposal = makeProposal({ authorId: "agt_author0000000000", authorKind: "agent" });
    const state = build({
      proposal,
      votes: { [alice.id]: vote("approve"), [bob.id]: vote("approve") },
    });
    expect(state.outcomePreview.outcome).toBe("open");
    expect(state.waitingOnNames).toEqual(["Carol"]);
  });
});

describe("buildVoteState — waitingOnNames", () => {
  it("falls back to the raw id for votes from ids not in the member list", () => {
    const state = build({ members: [alice, bob], activeMemberIds: [alice.id, bob.id, carol.id] });
    expect(state.waitingOnNames).toContain(carol.id);
  });
});
