/**
 * Concurrent votes = order independence. Votes arrive over the wire in
 * arbitrary order (CRDT sync, retries, races); the engine must produce the
 * exact same Resolution — including waitingOn ordering and reason strings —
 * for every permutation of the vote array. Property-tested with a seeded
 * shuffle so failures are reproducible.
 */
import { describe, expect, it } from "vitest";

import { resolveProposal } from "../../src/consensus/engine";
import type { EngineProposal, EngineVote, ResolveProposalInput } from "../../src/consensus/types";
import { DEFAULT_POLICY, type ConsensusPolicy } from "../../src/schemas/policy";

const T0 = 1_000_000;
const EXPIRES = T0 + DEFAULT_POLICY.timeoutMs;

const ALICE = "mem_alice";
const BOB = "mem_bob";
const CARA = "mem_cara";
const DANA = "mem_dana";
const EVAN = "mem_evan";

const PROPOSAL: EngineProposal = {
  id: "prp_shuffle00000000",
  authorId: ALICE,
  authorKind: "human",
  createdAt: T0,
  expiresAt: EXPIRES,
};

/** mulberry32 — tiny deterministic PRNG so every run shuffles identically. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const SHUFFLES = 50;

function expectOrderIndependent(input: Omit<ResolveProposalInput, "proposal" | "now">): void {
  const base = resolveProposal({ proposal: PROPOSAL, now: T0 + 10, ...input });
  const rand = mulberry32(0xdecaf);
  for (let i = 0; i < SHUFFLES; i++) {
    const permuted = resolveProposal({
      proposal: PROPOSAL,
      now: T0 + 10,
      ...input,
      votes: shuffled(input.votes, rand),
    });
    // Full deep equality: outcome, member lists (and their order), reasons.
    expect(permuted).toEqual(base);
  }
}

function vote(memberId: string, value: EngineVote["value"], at: number): EngineVote {
  return { memberId, value, at };
}

describe("concurrent votes — shuffling the vote array never changes the resolution", () => {
  it("unanimous with mixed approve/abstain and an inactive member's vote", () => {
    expectOrderIndependent({
      policy: DEFAULT_POLICY,
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [
        vote(ALICE, "approve", T0 + 3),
        vote(BOB, "abstain", T0 + 2),
        vote(CARA, "approve", T0 + 4),
        vote(DANA, "reject", T0 + 1), // inactive — must stay ignored in every order
      ],
    });
  });

  it("unanimous pass with per-member vote revisions (latest at wins)", () => {
    expectOrderIndependent({
      policy: DEFAULT_POLICY,
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [
        vote(ALICE, "reject", T0 + 1),
        vote(ALICE, "approve", T0 + 6),
        vote(BOB, "abstain", T0 + 2),
        vote(BOB, "approve", T0 + 5),
        vote(CARA, "approve", T0 + 3),
      ],
    });
  });

  it("veto attribution: several rejects, earliest is the vetoer in every order", () => {
    expectOrderIndependent({
      policy: DEFAULT_POLICY,
      activeMemberIds: [ALICE, BOB, CARA, DANA],
      votes: [
        vote(CARA, "reject", T0 + 7),
        vote(BOB, "reject", T0 + 2),
        vote(DANA, "reject", T0 + 9),
        vote(ALICE, "approve", T0 + 1),
      ],
    });
  });

  it("exact-timestamp tie on one member resolves conservatively in every order", () => {
    expectOrderIndependent({
      policy: DEFAULT_POLICY,
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [
        vote(ALICE, "approve", T0 + 5),
        vote(ALICE, "reject", T0 + 5), // same instant — reject must win regardless of order
        vote(BOB, "approve", T0 + 1),
        vote(CARA, "approve", T0 + 2),
      ],
    });
  });

  it("exact-timestamp abstain/approve tie never accidentally approves", () => {
    expectOrderIndependent({
      policy: DEFAULT_POLICY,
      activeMemberIds: [ALICE, BOB],
      votes: [
        vote(ALICE, "approve", T0 + 4),
        vote(ALICE, "abstain", T0 + 4),
        vote(BOB, "approve", T0 + 1),
      ],
    });
  });

  it("majority (vetoIsFinal=false) hovering at the impossibility boundary", () => {
    expectOrderIndependent({
      policy: { ...DEFAULT_POLICY, rule: "majority", vetoIsFinal: false },
      activeMemberIds: [ALICE, BOB, CARA, DANA],
      votes: [
        vote(ALICE, "reject", T0 + 2),
        vote(BOB, "reject", T0 + 3),
        vote(CARA, "approve", T0 + 1),
      ],
    });
  });

  it("majority eager approval with revisions and an inactive straggler", () => {
    expectOrderIndependent({
      policy: { ...DEFAULT_POLICY, rule: "majority", vetoIsFinal: false },
      activeMemberIds: [ALICE, BOB, CARA, DANA, EVAN],
      votes: [
        vote(BOB, "reject", T0 + 1),
        vote(ALICE, "approve", T0 + 2),
        vote(CARA, "approve", T0 + 3),
        vote(DANA, "approve", T0 + 4),
        vote(BOB, "abstain", T0 + 5),
        vote("mem_ghost", "reject", T0 + 1), // never active
      ],
    });
  });

  it("threshold:2 with an approve arriving after a withdrawn reject", () => {
    expectOrderIndependent({
      policy: { ...DEFAULT_POLICY, rule: "threshold", thresholdN: 2, vetoIsFinal: false },
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [
        vote(ALICE, "approve", T0 + 1),
        vote(BOB, "reject", T0 + 2),
        vote(BOB, "approve", T0 + 8),
        vote(CARA, "abstain", T0 + 3),
      ],
    });
  });

  it("owner_only: non-binding non-owner votes never perturb the result", () => {
    expectOrderIndependent({
      policy: { ...DEFAULT_POLICY, rule: "owner_only" },
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [
        vote(BOB, "reject", T0 + 1),
        vote(CARA, "approve", T0 + 2),
        vote(ALICE, "abstain", T0 + 3),
      ],
      ownerMemberId: ALICE,
    });
  });

  it("autoApproveOwnProposals=true with the proposer's synthesized approve", () => {
    expectOrderIndependent({
      policy: { ...DEFAULT_POLICY, autoApproveOwnProposals: true },
      activeMemberIds: [ALICE, BOB, CARA],
      votes: [vote(BOB, "approve", T0 + 2), vote(CARA, "approve", T0 + 1)],
    });
  });

  it("holds across every rule for one large mixed vote log", () => {
    const votes: EngineVote[] = [
      vote(ALICE, "approve", T0 + 1),
      vote(BOB, "reject", T0 + 2),
      vote(BOB, "approve", T0 + 4),
      vote(CARA, "abstain", T0 + 3),
      vote(CARA, "approve", T0 + 3), // tie with her own abstain
      vote(DANA, "reject", T0 + 6),
      vote(EVAN, "approve", T0 + 5), // inactive
      vote("mem_ghost", "approve", T0 + 1),
    ];
    const policies: ConsensusPolicy[] = [
      DEFAULT_POLICY,
      { ...DEFAULT_POLICY, vetoIsFinal: false },
      { ...DEFAULT_POLICY, rule: "majority" },
      { ...DEFAULT_POLICY, rule: "majority", vetoIsFinal: false },
      { ...DEFAULT_POLICY, rule: "threshold", thresholdN: 3, vetoIsFinal: false },
      { ...DEFAULT_POLICY, rule: "owner_only" },
    ];
    for (const policy of policies) {
      expectOrderIndependent({
        policy,
        activeMemberIds: [ALICE, BOB, CARA, DANA],
        votes,
        ownerMemberId: BOB,
      });
    }
  });
});
