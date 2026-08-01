/**
 * Pure parts of the internal API: mention detection and the doc-staging step
 * (agent messages append; every operation and agent→agent mention becomes a
 * Proposal, never a direct mutation).
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { newId } from "@quorum/shared/ids";
import { DEFAULT_POLICY } from "@quorum/shared/schemas/policy";
import { getArtifacts, getProposals, listMessages, readProposal } from "@quorum/shared/yjs/doc";

import { detectAgentMentions, stageAgentResult } from "../src/internal-api";

const NOW = 1_753_400_000_000;

const researcher = { id: newId("agent"), name: "Researcher" };
const writer = { id: newId("agent"), name: "Writer" };
const boardAgents = [researcher, writer];

describe("detectAgentMentions", () => {
  it("finds literal agt_ ids belonging to board agents", () => {
    expect(detectAgentMentions(`ping ${writer.id} please`, boardAgents, researcher.id)).toEqual([
      writer.id,
    ]);
  });

  it("finds case-insensitive @Name mentions", () => {
    expect(detectAgentMentions("hey @writer, take over", boardAgents, researcher.id)).toEqual([
      writer.id,
    ]);
  });

  it("never reports the author itself", () => {
    expect(detectAgentMentions(`@Researcher ${researcher.id}`, boardAgents, researcher.id)).toEqual(
      [],
    );
  });

  it("ignores ids that are not on the board", () => {
    expect(detectAgentMentions(`ping ${newId("agent")}`, boardAgents, researcher.id)).toEqual([]);
  });
});

describe("stageAgentResult", () => {
  it("appends agent messages to chat with detected mentions", () => {
    const doc = new Y.Doc();
    const result = stageAgentResult({
      doc,
      agent: researcher,
      boardAgents,
      messages: [{ content: "Here's a first pass." }],
      operations: [],
      policy: DEFAULT_POLICY,
      now: NOW,
    });

    const messages = listMessages(doc);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("agent");
    expect(messages[0]?.authorId).toBe(researcher.id);
    expect(messages[0]?.name).toBe("Researcher");
    expect(result.messageIds).toEqual([messages[0]?.id]);
    expect(result.proposals).toHaveLength(0);
  });

  it("turns an agent→agent mention into an agent_prompt proposal, not a direct enqueue", () => {
    const doc = new Y.Doc();
    const result = stageAgentResult({
      doc,
      agent: researcher,
      boardAgents,
      messages: [{ content: "@Writer please draft the summary" }],
      operations: [],
      policy: DEFAULT_POLICY,
      now: NOW,
    });

    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal?.kind).toBe("agent_prompt");
    expect(proposal?.authorId).toBe(researcher.id);
    expect(proposal?.authorKind).toBe("agent");
    expect(proposal?.status).toBe("open");
    expect(proposal?.expiresAt).toBe(NOW + DEFAULT_POLICY.timeoutMs);
    expect(proposal?.payload).toEqual({
      kind: "agent_prompt",
      targetAgentId: writer.id,
      content: "@Writer please draft the summary",
    });
    // Staged in the doc for live vote chips.
    expect(readProposal(doc, proposal?.id ?? "")?.status).toBe("open");
  });

  it("stages artifact.create as a proposal with a pre-allocated artifact id — nothing is applied", () => {
    const doc = new Y.Doc();
    const result = stageAgentResult({
      doc,
      agent: researcher,
      boardAgents,
      messages: [],
      operations: [{ op: "artifact.create", type: "doc", title: "Q3 Brief", content: "# Q3" }],
      policy: DEFAULT_POLICY,
      now: NOW,
    });

    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal?.kind).toBe("artifact_create");
    expect(proposal?.affectedArtifactIds).toHaveLength(1);
    expect(proposal?.affectedArtifactIds[0]).toMatch(/^art_/);
    // NEVER applied directly: the canvas stays empty until consensus.
    expect(getArtifacts(doc).size).toBe(0);
    expect(getProposals(doc).size).toBe(1);
  });

  it("stages artifact.patch against the target artifact", () => {
    const doc = new Y.Doc();
    const artifactId = newId("artifact");
    const result = stageAgentResult({
      doc,
      agent: researcher,
      boardAgents,
      messages: [],
      operations: [
        {
          op: "artifact.patch",
          artifactId,
          patch: [{ op: "replace", path: "/content", value: "new" }],
        },
      ],
      policy: DEFAULT_POLICY,
      now: NOW,
    });

    const proposal = result.proposals[0];
    expect(proposal?.kind).toBe("artifact_patch");
    expect(proposal?.affectedArtifactIds).toEqual([artifactId]);
  });

  it("unwraps proposal.create with a prompt into an agent_prompt proposal", () => {
    const doc = new Y.Doc();
    const result = stageAgentResult({
      doc,
      agent: researcher,
      boardAgents,
      messages: [],
      operations: [
        {
          op: "proposal.create",
          title: "Hand off to Writer",
          summary: "Writer drafts the conclusion",
          prompt: { targetAgentId: writer.id, content: "draft the conclusion" },
        },
      ],
      policy: DEFAULT_POLICY,
      now: NOW,
    });

    const proposal = result.proposals[0];
    expect(proposal?.kind).toBe("agent_prompt");
    expect(proposal?.title).toBe("Hand off to Writer");
    expect(proposal?.payload).toEqual({
      kind: "agent_prompt",
      targetAgentId: writer.id,
      content: "draft the conclusion",
    });
  });

  it("unwraps proposal.create with a nested operation, keeping the agent's title/summary", () => {
    const doc = new Y.Doc();
    const result = stageAgentResult({
      doc,
      agent: researcher,
      boardAgents,
      messages: [],
      operations: [
        {
          op: "proposal.create",
          title: "New data table",
          summary: "Adds the Q3 metrics table",
          operation: {
            op: "artifact.create",
            type: "table",
            title: "Q3 Metrics",
            content: '{"cols":["kpi"],"rows":[{"kpi":"mrr"}]}',
          },
        },
      ],
      policy: DEFAULT_POLICY,
      now: NOW,
    });

    const proposal = result.proposals[0];
    expect(proposal?.kind).toBe("artifact_create");
    expect(proposal?.title).toBe("New data table");
    expect(proposal?.summary).toBe("Adds the Q3 metrics table");
    expect(getArtifacts(doc).size).toBe(0);
  });
});
