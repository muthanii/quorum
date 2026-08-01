/**
 * The resolution-application step against an in-memory Y.Doc with injected
 * fake stores — no Postgres, no Redis, no Hocuspocus lifecycle.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { newId } from "@quorum/shared/ids";
import { policySchema, DEFAULT_POLICY } from "@quorum/shared/schemas/policy";
import type { ProposalInput } from "@quorum/shared/schemas/proposal";
import { readBoardPolicy } from "@quorum/shared/yjs/board-meta";
import {
  castVote,
  createProposalInDoc,
  listMessages,
  readAgentStatuses,
  readArtifact,
  readProposal,
  setAgentStatus,
} from "@quorum/shared/yjs/doc";

import { memberIdForUser } from "../src/auth";
import { ConsensusController } from "../src/consensus";
import { nullLogger } from "../src/log";
import { PresenceTracker } from "../src/presence";
import type { AgentRecord, MemberRecord } from "../src/stores";
import { TurnDispatcher } from "../src/turns";
import { makeFakeAudit, makeFakeBoards, makeFakeQueue } from "./fakes";

const NOW = 1_753_400_000_000;
const boardId = newId("board");

const ownerUserId = newId("user");
const voterUserId = newId("user");
const ownerMemberId = memberIdForUser(ownerUserId) as string;
const voterMemberId = memberIdForUser(voterUserId) as string;

function member(userId: string, role: MemberRecord["role"] = "editor"): MemberRecord {
  return { userId, role, lastSeenAtMs: NOW - 1_000 };
}

function agentRecord(name: string): AgentRecord {
  return { id: newId("agent"), boardId, name, kind: "webhook", status: "ready" };
}

function proposalInput(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    id: newId("proposal"),
    kind: "artifact_create",
    title: "Create brief",
    summary: "New doc artifact",
    authorId: newId("agent"),
    authorKind: "agent",
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    status: "open",
    payload: {
      kind: "artifact_create",
      operation: { op: "artifact.create", type: "doc", title: "Brief", content: "# Brief" },
    },
    affectedArtifactIds: [],
    ...overrides,
  };
}

function setup(
  options: {
    members?: MemberRecord[];
    agents?: AgentRecord[];
    policy?: typeof DEFAULT_POLICY;
    now?: number;
  } = {},
) {
  const doc = new Y.Doc();
  const boards = makeFakeBoards({
    board: { id: boardId, ownerUserId, policy: options.policy ?? DEFAULT_POLICY },
    members: options.members ?? [member(ownerUserId, "owner"), member(voterUserId)],
    agents: options.agents ?? [],
  });
  const audit = makeFakeAudit();
  const queue = makeFakeQueue();
  const now = () => options.now ?? NOW;
  const presence = new PresenceTracker({ boards, log: nullLogger(), now });
  const turns = new TurnDispatcher({ boards, queue, log: nullLogger() });
  const controller = new ConsensusController({
    boards,
    audit,
    presence,
    turns,
    log: nullLogger(),
    now,
  });
  return { doc, boards, audit, queue, presence, controller };
}

describe("approved artifact.create proposal", () => {
  it("applies the artifact, sets status, and audits proposal + votes", async () => {
    const { doc, audit, controller } = setup();
    const preallocatedId = newId("artifact");
    const proposal = createProposalInDoc(
      doc,
      proposalInput({ affectedArtifactIds: [preallocatedId] }),
    );
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterMemberId, "approve", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    // Applied atomically: artifact exists under the pre-allocated id.
    const artifact = readArtifact(doc, preallocatedId);
    expect(artifact?.meta.title).toBe("Brief");
    expect(artifact?.body).toBe("# Brief");
    expect(artifact?.meta.authorAgentId).toBe(proposal.authorId);
    expect(readProposal(doc, proposal.id)?.status).toBe("applied");

    // Audited append-only with the engine resolution and both votes.
    expect(audit.resolutions).toHaveLength(1);
    const audited = audit.resolutions[0];
    expect(audited?.proposal.id).toBe(proposal.id);
    expect(audited?.status).toBe("applied");
    expect(audited?.resolution.outcome).toBe("approved");
    expect(audited?.votes.map((vote) => vote.memberId).sort()).toEqual(
      [ownerMemberId, voterMemberId].sort(),
    );
    expect(audited?.resolvedAt).toEqual(new Date(NOW));
  });

  it("resolves votes keyed by usr_ ids — the id space web clients write", async () => {
    const { doc, controller } = setup();
    const proposal = createProposalInDoc(doc, proposalInput());
    castVote(doc, proposal.id, ownerUserId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterUserId, "approve", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
  });

  it("stays open until every active member has approved, then applies on the vote", async () => {
    const { doc, controller } = setup();
    const proposal = createProposalInDoc(doc, proposalInput());
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);
    expect(readProposal(doc, proposal.id)?.status).toBe("open");

    // Second member votes — the deep observer triggers re-evaluation.
    castVote(doc, proposal.id, voterMemberId, "approve", NOW - 100);
    await controller.idle(boardId);
    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
  });
});

describe("veto and expiry", () => {
  it("a single reject resolves rejected immediately and applies nothing", async () => {
    const { doc, audit, controller } = setup();
    const proposal = createProposalInDoc(doc, proposalInput());
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterMemberId, "reject", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("rejected");
    expect(readArtifact(doc, proposal.affectedArtifactIds[0] ?? "art_none")).toBeNull();
    const audited = audit.resolutions[0];
    expect(audited?.resolution.outcome).toBe("rejected");
    expect(audited?.resolution.outcome === "rejected" ? audited.resolution.vetoedBy : null).toBe(
      voterMemberId,
    );
  });

  it("expires a timed-out proposal (never auto-approve)", async () => {
    const { doc, audit, controller } = setup({ now: NOW + 600_000 });
    const proposal = createProposalInDoc(doc, proposalInput());

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("expired");
    expect(audit.resolutions[0]?.status).toBe("expired");
  });
});

describe("approved but unappliable operations", () => {
  it("resolves rejected with a visible system message when the patch target is missing", async () => {
    const { doc, audit, controller } = setup();
    const proposal = createProposalInDoc(
      doc,
      proposalInput({
        kind: "artifact_patch",
        payload: {
          kind: "artifact_patch",
          operation: {
            op: "artifact.patch",
            artifactId: newId("artifact"), // does not exist
            patch: [{ op: "replace", path: "/content", value: "x" }],
          },
        },
      }),
    );
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterMemberId, "approve", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("rejected");
    const system = listMessages(doc).find((message) => message.role === "system");
    expect(system?.content).toMatch(/could not be applied/);
    expect(audit.resolutions[0]?.status).toBe("rejected");
  });
});

describe("approved agent_prompt proposal", () => {
  it('enqueues a turn with trigger "proposal_approved" carrying the prompt', async () => {
    const author = agentRecord("Researcher");
    const target = agentRecord("Writer");
    const { doc, queue, controller } = setup({ agents: [author, target] });
    setAgentStatus(doc, author.id, "ready", NOW);
    setAgentStatus(doc, target.id, "ready", NOW);

    const proposal = createProposalInDoc(
      doc,
      proposalInput({
        kind: "agent_prompt",
        authorId: author.id,
        payload: { kind: "agent_prompt", targetAgentId: target.id, content: "draft the intro" },
      }),
    );
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterMemberId, "approve", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
    expect(queue.jobs).toHaveLength(1);
    const job = queue.jobs[0];
    expect(job?.agentId).toBe(target.id);
    expect(job?.trigger).toEqual({ type: "proposal_approved" });
    expect(job?.context.messages.at(-1)).toEqual({
      role: "agent",
      authorId: author.id,
      name: "Researcher",
      content: "draft the intro",
    });
  });
});

describe("approved policy_change proposal", () => {
  it("updates pg, mirrors into boardMeta, and marks applied", async () => {
    const { doc, boards, controller } = setup();
    const newPolicy = policySchema.parse({ rule: "majority" });
    const proposal = createProposalInDoc(
      doc,
      proposalInput({
        kind: "policy_change",
        authorId: ownerUserId,
        authorKind: "human",
        payload: { kind: "policy_change", policy: newPolicy },
      }),
    );
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterMemberId, "approve", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
    expect(boards.policyUpdates).toEqual([newPolicy]);
    expect(boards.board.policy).toEqual(newPolicy);
    expect(readBoardPolicy(doc)).toEqual(newPolicy);
  });
});

describe("approved add_agent / remove_agent proposals", () => {
  it("add_agent flips participation: pg status + doc agentStatus entry", async () => {
    const pending = agentRecord("Pending");
    const { doc, boards, controller } = setup({ agents: [pending] });
    const proposal = createProposalInDoc(
      doc,
      proposalInput({
        kind: "add_agent",
        title: "Add Pending",
        payload: { kind: "add_agent", agentId: pending.id, name: "Pending", agentKind: "webhook" },
      }),
    );
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterMemberId, "approve", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
    expect(boards.statusUpdates).toEqual([{ agentId: pending.id, status: "ready" }]);
    expect(readAgentStatuses(doc)[pending.id]?.status).toBe("ready");
  });

  it("remove_agent deletes the pg row and the doc roster entry", async () => {
    const leaving = agentRecord("Leaving");
    const { doc, boards, controller } = setup({ agents: [leaving] });
    setAgentStatus(doc, leaving.id, "ready", NOW);
    const proposal = createProposalInDoc(
      doc,
      proposalInput({
        kind: "remove_agent",
        title: "Remove Leaving",
        payload: { kind: "remove_agent", agentId: leaving.id },
      }),
    );
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterMemberId, "approve", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
    expect(boards.removedAgentIds).toEqual([leaving.id]);
    expect(readAgentStatuses(doc)[leaving.id]).toBeUndefined();
  });
});

describe("policy mirror on attach", () => {
  it("mirrors the pg policy into boardMeta when the doc loads", async () => {
    const policy = policySchema.parse({ rule: "owner_only" });
    const { doc, controller } = setup({ policy });
    await controller.attach(boardId, doc);
    expect(readBoardPolicy(doc)).toEqual(policy);
  });
});

describe("inactive members leave the quorum", () => {
  it("a proposal approves without a member who fell outside the active window", async () => {
    const staleUserId = newId("user");
    const { doc, controller } = setup({
      members: [
        member(ownerUserId, "owner"),
        member(voterUserId),
        { userId: staleUserId, role: "editor", lastSeenAtMs: NOW - 600_000 }, // stale
      ],
    });
    const proposal = createProposalInDoc(doc, proposalInput());
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterMemberId, "approve", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
  });

  it("a connected guest editor without a pg member row still counts", async () => {
    const guestUserId = newId("user");
    const guestMemberId = memberIdForUser(guestUserId) as string;
    const { doc, presence, controller } = setup({
      members: [member(ownerUserId, "owner")],
    });
    await presence.connect(boardId, "socket-1", {
      userId: guestUserId,
      memberId: guestMemberId,
      boardId,
      role: "editor",
      name: "Guest",
      color: "#fff",
      readOnly: false,
    });

    const proposal = createProposalInDoc(doc, proposalInput());
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);
    // Guest has not voted yet → unanimous not reached.
    expect(readProposal(doc, proposal.id)?.status).toBe("open");

    castVote(doc, proposal.id, guestMemberId, "approve", NOW - 100);
    await controller.idle(boardId);
    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
  });
});

describe("consensus never applies unapproved operations", () => {
  it("leaves an open proposal's artifact uncreated", async () => {
    const { doc, controller } = setup();
    const artifactId = newId("artifact");
    createProposalInDoc(doc, proposalInput({ affectedArtifactIds: [artifactId] }));

    await controller.attach(boardId, doc);
    await controller.idle(boardId);

    expect(readArtifact(doc, artifactId)).toBeNull();
  });

  it("does not double-apply an already-applied proposal on re-evaluation", async () => {
    const { doc, controller } = setup();
    const artifactId = newId("artifact");
    const proposal = createProposalInDoc(doc, proposalInput({ affectedArtifactIds: [artifactId] }));
    castVote(doc, proposal.id, ownerMemberId, "approve", NOW - 500);
    castVote(doc, proposal.id, voterMemberId, "approve", NOW - 400);

    await controller.attach(boardId, doc);
    await controller.idle(boardId);
    expect(readProposal(doc, proposal.id)?.status).toBe("applied");

    // Simulate a later tick: nothing new must happen.
    await controller.evaluateBoard(boardId);
    const artifact = readArtifact(doc, artifactId);
    expect(artifact).not.toBeNull();
    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
  });
});
