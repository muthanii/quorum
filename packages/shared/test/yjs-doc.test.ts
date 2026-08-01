import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { newId } from "../src/ids";
import type { ArtifactMeta, TableBody } from "../src/schemas/artifact";
import type { MessageInput } from "../src/schemas/message";
import type { ProposalInput } from "../src/schemas/proposal";
import {
  appendMessage,
  applyOperationToDoc,
  castVote,
  createArtifactInDoc,
  createProposalInDoc,
  getArtifacts,
  getChat,
  listMessages,
  readAgentStatuses,
  readArtifact,
  readProposal,
  setAgentStatus,
  setProposalStatus,
} from "../src/yjs/doc";

const NOW = 1_753_400_000_000;

function makeMessage(content: string, overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    id: newId("message"),
    role: "human",
    authorId: newId("user"),
    name: "Dana",
    content,
    createdAt: NOW,
    ...overrides,
  };
}

function docMeta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    type: "doc",
    title: "Brief",
    x: 100,
    y: 100,
    w: 480,
    h: 400,
    createdAt: NOW,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    id: newId("proposal"),
    kind: "artifact_create",
    title: "Create brief",
    summary: "New doc",
    authorId: newId("agent"),
    authorKind: "agent",
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    status: "open",
    payload: {
      kind: "artifact_create",
      operation: { op: "artifact.create", type: "doc", title: "Brief", content: "# Brief" },
    },
    ...overrides,
  };
}

describe("chat helpers", () => {
  it("round-trips appendMessage → listMessages", () => {
    const doc = new Y.Doc();
    const message = appendMessage(doc, makeMessage("hello"));
    expect(listMessages(doc)).toEqual([message]);
  });

  it("listMessages(limit) returns only the tail, in order", () => {
    const doc = new Y.Doc();
    const sent = ["one", "two", "three", "four", "five"].map((content) =>
      appendMessage(doc, makeMessage(content)),
    );
    expect(listMessages(doc, 2).map((m) => m.content)).toEqual(["four", "five"]);
    expect(listMessages(doc, 100)).toEqual(sent);
  });

  it("skips malformed entries written by a misbehaving peer", () => {
    const doc = new Y.Doc();
    appendMessage(doc, makeMessage("valid"));
    getChat(doc).push([new Y.Map<unknown>(Object.entries({ garbage: true }))]);
    const messages = listMessages(doc);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("valid");
  });

  it("rejects an invalid message before writing anything", () => {
    const doc = new Y.Doc();
    expect(() => appendMessage(doc, makeMessage("x", { id: "bogus" }))).toThrow();
    expect(getChat(doc).length).toBe(0);
  });
});

describe("artifact helpers", () => {
  it("round-trips a doc artifact (body → Y.Text → string)", () => {
    const doc = new Y.Doc();
    const id = newId("artifact");
    createArtifactInDoc(doc, { id, meta: docMeta(), body: "# Brief\ntext" });
    expect(readArtifact(doc, id)).toEqual({ id, meta: docMeta(), body: "# Brief\ntext" });
  });

  it("round-trips a table artifact (cols + rows)", () => {
    const doc = new Y.Doc();
    const id = newId("artifact");
    const body: TableBody = {
      cols: ["metric", "value"],
      rows: [
        { metric: "MRR", value: "12k" },
        { metric: "churn", value: "2%" },
      ],
    };
    const meta = docMeta({ type: "table", authorAgentId: newId("agent") });
    createArtifactInDoc(doc, { id, meta, body });
    expect(readArtifact(doc, id)).toEqual({ id, meta, body });
  });

  it("returns null for a missing artifact", () => {
    expect(readArtifact(new Y.Doc(), newId("artifact"))).toBeNull();
  });

  it("rejects a body/type mismatch before writing anything", () => {
    const doc = new Y.Doc();
    expect(() =>
      createArtifactInDoc(doc, {
        id: newId("artifact"),
        meta: docMeta({ type: "table" }),
        body: "not a table",
      }),
    ).toThrow();
    expect(getArtifacts(doc).size).toBe(0);
  });
});

describe("proposal helpers", () => {
  it("round-trips a proposal with an empty votes map", () => {
    const doc = new Y.Doc();
    const proposal = createProposalInDoc(doc, makeProposal());
    expect(readProposal(doc, proposal.id)).toEqual({ ...proposal, votes: {} });
  });

  it("castVote writes only that member's vote and can be changed", () => {
    const doc = new Y.Doc();
    const { id } = createProposalInDoc(doc, makeProposal());
    const alice = newId("member");
    const bob = newId("member");

    expect(castVote(doc, id, alice, "approve", NOW)).toBe(true);
    expect(castVote(doc, id, bob, "reject", NOW + 1)).toBe(true);
    expect(readProposal(doc, id)?.votes).toEqual({
      [alice]: { value: "approve", at: NOW },
      [bob]: { value: "reject", at: NOW + 1 },
    });

    expect(castVote(doc, id, bob, "approve", NOW + 2)).toBe(true);
    expect(readProposal(doc, id)?.votes[bob]).toEqual({ value: "approve", at: NOW + 2 });
  });

  it("castVote and setProposalStatus report false for unknown proposals", () => {
    const doc = new Y.Doc();
    expect(castVote(doc, newId("proposal"), newId("member"), "approve", NOW)).toBe(false);
    expect(setProposalStatus(doc, newId("proposal"), "applied")).toBe(false);
  });

  it("setProposalStatus updates the live status", () => {
    const doc = new Y.Doc();
    const { id } = createProposalInDoc(doc, makeProposal());
    expect(setProposalStatus(doc, id, "applied")).toBe(true);
    expect(readProposal(doc, id)?.status).toBe("applied");
  });
});

describe("agent status helpers", () => {
  it("round-trips setAgentStatus → readAgentStatuses", () => {
    const doc = new Y.Doc();
    const researcher = newId("agent");
    const writer = newId("agent");
    setAgentStatus(doc, researcher, "running", NOW);
    setAgentStatus(doc, writer, "degraded", NOW + 5);
    setAgentStatus(doc, researcher, "ready", NOW + 9);
    expect(readAgentStatuses(doc)).toEqual({
      [researcher]: { status: "ready", at: NOW + 9 },
      [writer]: { status: "degraded", at: NOW + 5 },
    });
  });
});

describe("applyOperationToDoc", () => {
  it("creates a doc artifact inside the caller's transaction", () => {
    const doc = new Y.Doc();
    const authorAgentId = newId("agent");
    let id = "";
    doc.transact(() => {
      id = applyOperationToDoc(
        doc,
        { op: "artifact.create", type: "doc", title: "Q3 Brief", content: "# Q3" },
        { now: NOW, authorAgentId },
      );
    });
    const artifact = readArtifact(doc, id);
    expect(artifact?.body).toBe("# Q3");
    expect(artifact?.meta.title).toBe("Q3 Brief");
    expect(artifact?.meta.authorAgentId).toBe(authorAgentId);
    expect(artifact?.meta.createdAt).toBe(NOW);
  });

  it("creates a table artifact from JSON content and honors a pre-allocated id", () => {
    const doc = new Y.Doc();
    const artifactId = newId("artifact");
    const body: TableBody = { cols: ["kpi"], rows: [{ kpi: "MRR" }] };
    const id = applyOperationToDoc(
      doc,
      { op: "artifact.create", type: "table", title: "KPIs", content: JSON.stringify(body) },
      { now: NOW, artifactId },
    );
    expect(id).toBe(artifactId);
    expect(readArtifact(doc, id)?.body).toEqual(body);
  });

  it("rejects malformed table content before touching the doc", () => {
    const doc = new Y.Doc();
    expect(() =>
      applyOperationToDoc(
        doc,
        { op: "artifact.create", type: "table", title: "KPIs", content: "not json" },
        { now: NOW },
      ),
    ).toThrow();
    expect(getArtifacts(doc).size).toBe(0);
  });

  it("patches a doc artifact's title and content", () => {
    const doc = new Y.Doc();
    const id = newId("artifact");
    createArtifactInDoc(doc, { id, meta: docMeta(), body: "hello world" });
    applyOperationToDoc(
      doc,
      {
        op: "artifact.patch",
        artifactId: id,
        patch: [
          { op: "replace", path: "/title", value: "Brief v2" },
          { op: "replace", path: "/content", value: "hello brave world" },
        ],
      },
      { now: NOW },
    );
    const artifact = readArtifact(doc, id);
    expect(artifact?.meta.title).toBe("Brief v2");
    expect(artifact?.body).toBe("hello brave world");
  });

  it("patches a table artifact's rows (replace and append)", () => {
    const doc = new Y.Doc();
    const id = newId("artifact");
    createArtifactInDoc(doc, {
      id,
      meta: docMeta({ type: "table" }),
      body: { cols: ["kpi", "value"], rows: [{ kpi: "MRR", value: "12k" }] },
    });
    applyOperationToDoc(
      doc,
      {
        op: "artifact.patch",
        artifactId: id,
        patch: [
          { op: "replace", path: "/rows/0/value", value: "14k" },
          { op: "add", path: "/rows/-", value: { kpi: "churn", value: "2%" } },
        ],
      },
      { now: NOW },
    );
    expect(readArtifact(doc, id)?.body).toEqual({
      cols: ["kpi", "value"],
      rows: [
        { kpi: "MRR", value: "14k" },
        { kpi: "churn", value: "2%" },
      ],
    });
  });

  it("is atomic: an invalid patch leaves the artifact completely untouched", () => {
    const doc = new Y.Doc();
    const id = newId("artifact");
    createArtifactInDoc(doc, { id, meta: docMeta(), body: "original" });
    // The title replace is valid but the content value is not a string — the
    // whole patch must be discarded, including the earlier title change.
    expect(() =>
      applyOperationToDoc(
        doc,
        {
          op: "artifact.patch",
          artifactId: id,
          patch: [
            { op: "replace", path: "/title", value: "Sneaky" },
            { op: "replace", path: "/content", value: 42 },
          ],
        },
        { now: NOW },
      ),
    ).toThrow();
    expect(readArtifact(doc, id)).toEqual({ id, meta: docMeta(), body: "original" });
  });

  it("fails a `test` op without applying anything", () => {
    const doc = new Y.Doc();
    const id = newId("artifact");
    createArtifactInDoc(doc, { id, meta: docMeta(), body: "original" });
    expect(() =>
      applyOperationToDoc(
        doc,
        {
          op: "artifact.patch",
          artifactId: id,
          patch: [
            { op: "test", path: "/content", value: "something else" },
            { op: "replace", path: "/content", value: "changed" },
          ],
        },
        { now: NOW },
      ),
    ).toThrow();
    expect(readArtifact(doc, id)?.body).toBe("original");
  });

  it("throws for a missing artifact", () => {
    expect(() =>
      applyOperationToDoc(
        new Y.Doc(),
        {
          op: "artifact.patch",
          artifactId: newId("artifact"),
          patch: [{ op: "remove", path: "/title" }],
        },
        { now: NOW },
      ),
    ).toThrow(/not found/);
  });
});

describe("two-doc convergence", () => {
  function syncBothWays(a: Y.Doc, b: Y.Doc): void {
    const updateA = Y.encodeStateAsUpdate(a);
    const updateB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, updateB);
    Y.applyUpdate(b, updateA);
  }

  it("concurrent appendMessage + createArtifactInDoc converge to identical state", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();

    const artifactA = newId("artifact");
    const artifactB = newId("artifact");
    appendMessage(a, makeMessage("from A"));
    createArtifactInDoc(a, { id: artifactA, meta: docMeta({ title: "A's doc" }), body: "aaa" });
    appendMessage(b, makeMessage("from B"));
    createArtifactInDoc(b, {
      id: artifactB,
      meta: docMeta({ type: "table", title: "B's table" }),
      body: { cols: ["c"], rows: [{ c: "1" }] },
    });

    syncBothWays(a, b);

    // Both docs settle on the same chat order and the same artifacts.
    expect(listMessages(a)).toEqual(listMessages(b));
    expect(
      listMessages(a)
        .map((m) => m.content)
        .sort(),
    ).toEqual(["from A", "from B"]);
    for (const id of [artifactA, artifactB]) {
      expect(readArtifact(a, id)).toEqual(readArtifact(b, id));
      expect(readArtifact(a, id)).not.toBeNull();
    }
    expect(getArtifacts(a).size).toBe(2);
    expect(getArtifacts(b).size).toBe(2);
  });

  it("concurrent votes from different members merge without conflict", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const proposal = createProposalInDoc(a, makeProposal());
    syncBothWays(a, b);

    const alice = newId("member");
    const bob = newId("member");
    castVote(a, proposal.id, alice, "approve", NOW);
    castVote(b, proposal.id, bob, "reject", NOW + 1);

    syncBothWays(a, b);

    const expected = {
      [alice]: { value: "approve", at: NOW },
      [bob]: { value: "reject", at: NOW + 1 },
    };
    expect(readProposal(a, proposal.id)?.votes).toEqual(expected);
    expect(readProposal(b, proposal.id)?.votes).toEqual(expected);
  });
});
