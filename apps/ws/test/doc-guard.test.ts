/**
 * Vote forgery is the one attack that breaks the whole product: if a single
 * member can write everyone else's approval, "nothing ships without everyone's
 * yes" is a lie. These tests drive the controller exactly the way Hocuspocus
 * does — client updates applied with a Connection-shaped origin — and assert
 * that only the connection's own vote survives.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { newId } from "@quorum/shared/ids";
import { DEFAULT_POLICY } from "@quorum/shared/schemas/policy";
import { createProposalInDoc, getProposals, readProposal } from "@quorum/shared/yjs/doc";

import { memberIdForUser } from "../src/auth";
import { ConsensusController } from "../src/consensus";
import { nullLogger } from "../src/log";
import { PresenceTracker } from "../src/presence";
import type { MemberRecord } from "../src/stores";
import { TurnDispatcher } from "../src/turns";
import { makeFakeAudit, makeFakeBoards, makeFakeQueue } from "./fakes";

const NOW = 1_753_400_000_000;
const boardId = newId("board");
const aliceUserId = newId("user");
const bobUserId = newId("user");

/** What Hocuspocus passes as the transaction origin for a client update. */
function connectionOf(userId: string): { context: { userId: string } } {
  return { context: { userId } };
}

function member(userId: string, role: MemberRecord["role"] = "editor"): MemberRecord {
  return { userId, role, lastSeenAtMs: NOW - 1_000 };
}

function setup() {
  const doc = new Y.Doc();
  const boards = makeFakeBoards({
    board: { id: boardId, ownerUserId: aliceUserId, policy: DEFAULT_POLICY },
    members: [member(aliceUserId, "owner"), member(bobUserId)],
    agents: [],
  });
  const audit = makeFakeAudit();
  const queue = makeFakeQueue();
  const now = () => NOW;
  const presence = new PresenceTracker({ boards, log: nullLogger(), now });
  const controller = new ConsensusController({
    boards,
    audit,
    presence,
    turns: new TurnDispatcher({ boards, queue, log: nullLogger() }),
    log: nullLogger(),
    now,
  });
  return { doc, audit, controller };
}

function stageProposal(doc: Y.Doc, authorUserId: string) {
  return createProposalInDoc(doc, {
    id: newId("proposal"),
    kind: "artifact_create",
    title: "Create brief",
    summary: "New doc artifact",
    authorId: authorUserId,
    authorKind: "human",
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    status: "open",
    payload: {
      kind: "artifact_create",
      operation: { op: "artifact.create", type: "doc", title: "Brief", content: "# Brief" },
    },
    affectedArtifactIds: [],
  });
}

/** Write a vote the way a malicious client would: straight into the CRDT. */
function writeVoteAs(
  doc: Y.Doc,
  connection: unknown,
  proposalId: string,
  voteKey: string,
  value: "approve" | "reject",
) {
  const entry = getProposals(doc).get(proposalId) as Y.Map<unknown>;
  const votes = entry.get("votes") as Y.Map<unknown>;
  doc.transact(() => {
    votes.set(voteKey, { value, at: NOW });
  }, connection);
}

describe("vote forgery", () => {
  it("reverts a vote written under another member's id and refuses to approve", async () => {
    const { doc, audit, controller } = setup();
    const proposal = stageProposal(doc, bobUserId);
    await controller.attach(boardId, doc);

    // Bob approves as himself (legitimate) and as Alice (forged).
    writeVoteAs(doc, connectionOf(bobUserId), proposal.id, bobUserId, "approve");
    writeVoteAs(doc, connectionOf(bobUserId), proposal.id, aliceUserId, "approve");
    await controller.idle(boardId);

    const after = readProposal(doc, proposal.id);
    expect(Object.keys(after?.votes ?? {})).toEqual([bobUserId]);
    expect(after?.status).toBe("open");
    expect(audit.resolutions).toHaveLength(0);
  });

  it("reverts a forged vote written under the derived mem_ id too", async () => {
    const { doc, controller } = setup();
    const proposal = stageProposal(doc, bobUserId);
    await controller.attach(boardId, doc);

    writeVoteAs(doc, connectionOf(bobUserId), proposal.id, bobUserId, "approve");
    writeVoteAs(
      doc,
      connectionOf(bobUserId),
      proposal.id,
      memberIdForUser(aliceUserId) as string,
      "approve",
    );
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("open");
  });

  it("restores a vote a member tried to delete or overwrite", async () => {
    const { doc, controller } = setup();
    const proposal = stageProposal(doc, bobUserId);
    await controller.attach(boardId, doc);

    writeVoteAs(doc, connectionOf(aliceUserId), proposal.id, aliceUserId, "reject");
    await controller.idle(boardId);

    // Bob tries to flip Alice's veto to an approval, then to erase it.
    writeVoteAs(doc, connectionOf(bobUserId), proposal.id, aliceUserId, "approve");
    const votes = (getProposals(doc).get(proposal.id) as Y.Map<unknown>).get(
      "votes",
    ) as Y.Map<unknown>;
    doc.transact(() => votes.delete(aliceUserId), connectionOf(bobUserId));
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.votes[aliceUserId]?.value).toBe("reject");
  });

  it("still lets each member cast their own vote to a real unanimous approval", async () => {
    const { doc, controller } = setup();
    const proposal = stageProposal(doc, bobUserId);
    await controller.attach(boardId, doc);

    writeVoteAs(doc, connectionOf(bobUserId), proposal.id, bobUserId, "approve");
    writeVoteAs(doc, connectionOf(aliceUserId), proposal.id, aliceUserId, "approve");
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
  });
});

describe("proposal field tampering", () => {
  it("reverts a client marking its own proposal applied", async () => {
    const { doc, controller } = setup();
    const proposal = stageProposal(doc, bobUserId);
    await controller.attach(boardId, doc);

    const entry = getProposals(doc).get(proposal.id) as Y.Map<unknown>;
    doc.transact(() => entry.set("status", "applied"), connectionOf(bobUserId));
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("open");
  });

  it("reverts a payload swap after votes are in — vote on X, apply Y", async () => {
    const { doc, controller } = setup();
    const proposal = stageProposal(doc, bobUserId);
    await controller.attach(boardId, doc);

    writeVoteAs(doc, connectionOf(bobUserId), proposal.id, bobUserId, "approve");

    const entry = getProposals(doc).get(proposal.id) as Y.Map<unknown>;
    doc.transact(() => {
      entry.set("payload", {
        kind: "artifact_create",
        operation: { op: "artifact.create", type: "doc", title: "Swapped", content: "evil" },
      });
    }, connectionOf(bobUserId));

    writeVoteAs(doc, connectionOf(aliceUserId), proposal.id, aliceUserId, "approve");
    await controller.idle(boardId);

    const applied = readProposal(doc, proposal.id);
    expect(applied?.status).toBe("applied");
    // The originally-voted-on payload is what got applied.
    expect(JSON.stringify(applied?.payload)).toContain("Brief");
    expect(JSON.stringify(applied?.payload)).not.toContain("Swapped");
  });

  it("reverts an expiry extension that would keep a dead proposal alive", async () => {
    const { doc, controller } = setup();
    const proposal = stageProposal(doc, bobUserId);
    await controller.attach(boardId, doc);

    const entry = getProposals(doc).get(proposal.id) as Y.Map<unknown>;
    doc.transact(() => entry.set("expiresAt", NOW + 86_400_000), connectionOf(bobUserId));
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.expiresAt).toBe(NOW + 300_000);
  });

  it("leaves server-origin writes alone", async () => {
    const { doc, controller } = setup();
    const proposal = stageProposal(doc, bobUserId);
    await controller.attach(boardId, doc);

    // Both members approve — the controller itself sets status "applied".
    writeVoteAs(doc, connectionOf(bobUserId), proposal.id, bobUserId, "approve");
    writeVoteAs(doc, connectionOf(aliceUserId), proposal.id, aliceUserId, "approve");
    await controller.idle(boardId);

    expect(readProposal(doc, proposal.id)?.status).toBe("applied");
  });
});
