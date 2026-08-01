import { describe, expect, it } from "vitest";

import { newId } from "../src/ids";
import { agentSchema } from "../src/schemas/agent";
import { artifactSchema } from "../src/schemas/artifact";
import { boardSchema } from "../src/schemas/board";
import { memberSchema } from "../src/schemas/member";
import { messageSchema } from "../src/schemas/message";
import { DEFAULT_POLICY, policySchema } from "../src/schemas/policy";
import { proposalSchema, type ProposalInput } from "../src/schemas/proposal";
import { voteEntrySchema, voteSchema, voteValueSchema } from "../src/schemas/vote";

const NOW = 1_753_400_000_000;

describe("policySchema", () => {
  it("defaults exactly to CLAUDE.md §6", () => {
    expect(DEFAULT_POLICY).toEqual({
      rule: "unanimous",
      quorum: "active",
      timeoutMs: 5 * 60 * 1000,
      onTimeout: "reject",
      vetoIsFinal: true,
      autoApproveOwnProposals: false,
    });
    expect(policySchema.parse({})).toEqual(DEFAULT_POLICY);
  });

  it("accepts threshold only with thresholdN", () => {
    expect(policySchema.safeParse({ rule: "threshold" }).success).toBe(false);
    expect(policySchema.safeParse({ rule: "threshold", thresholdN: 2 }).success).toBe(true);
    expect(policySchema.safeParse({ rule: "threshold", thresholdN: 0 }).success).toBe(false);
  });

  it("rejects unknown rules, auto-approve timeouts, and bad timeouts", () => {
    expect(policySchema.safeParse({ rule: "plurality" }).success).toBe(false);
    expect(policySchema.safeParse({ onTimeout: "approve" }).success).toBe(false);
    expect(policySchema.safeParse({ quorum: "everyone" }).success).toBe(false);
    expect(policySchema.safeParse({ timeoutMs: 0 }).success).toBe(false);
  });
});

describe("boardSchema", () => {
  const board = {
    id: newId("board"),
    name: "Q3 planning",
    ownerId: newId("user"),
    policy: DEFAULT_POLICY,
    createdAt: NOW,
  };

  it("accepts a valid board", () => {
    expect(boardSchema.parse(board)).toEqual(board);
  });

  it("rejects a wrong-kind owner id and an empty name", () => {
    expect(boardSchema.safeParse({ ...board, ownerId: newId("member") }).success).toBe(false);
    expect(boardSchema.safeParse({ ...board, name: "" }).success).toBe(false);
  });
});

describe("memberSchema", () => {
  const member = {
    id: newId("member"),
    boardId: newId("board"),
    userId: newId("user"),
    name: "Dana",
    role: "editor",
    lastSeenAt: NOW,
  };

  it("accepts every role", () => {
    for (const role of ["owner", "editor", "viewer"]) {
      expect(memberSchema.safeParse({ ...member, role }).success).toBe(true);
    }
  });

  it("rejects unknown roles and negative lastSeenAt", () => {
    expect(memberSchema.safeParse({ ...member, role: "admin" }).success).toBe(false);
    expect(memberSchema.safeParse({ ...member, lastSeenAt: -1 }).success).toBe(false);
  });
});

describe("agentSchema", () => {
  const agent = {
    id: newId("agent"),
    boardId: newId("board"),
    ownerMemberId: newId("member"),
    name: "Researcher",
    kind: "webhook",
    endpoint: "https://agents.example.com/hook",
    maskedKey: "…abc4",
    status: "ready",
    createdAt: NOW,
  };

  it("accepts a valid webhook agent and a model agent", () => {
    expect(agentSchema.safeParse(agent).success).toBe(true);
    expect(
      agentSchema.safeParse({ ...agent, kind: "model", model: "claude-sonnet-4-5" }).success,
    ).toBe(true);
    expect(agentSchema.safeParse({ ...agent, maskedKey: null }).success).toBe(true);
  });

  it("rejects any extra field — a raw credential can never ride along", () => {
    for (const smuggled of ["apiKey", "token", "credential", "secret"]) {
      expect(agentSchema.safeParse({ ...agent, [smuggled]: "sk-live-oops" }).success).toBe(false);
    }
  });

  it("rejects unknown status/kind and non-URL endpoints", () => {
    expect(agentSchema.safeParse({ ...agent, status: "offline" }).success).toBe(false);
    expect(agentSchema.safeParse({ ...agent, kind: "cli" }).success).toBe(false);
    expect(agentSchema.safeParse({ ...agent, endpoint: "not a url" }).success).toBe(false);
  });
});

describe("messageSchema", () => {
  const message = {
    id: newId("message"),
    role: "human",
    authorId: newId("user"),
    name: "Dana",
    content: "hello",
    createdAt: NOW,
  };

  it("accepts a message and defaults mentions to []", () => {
    expect(messageSchema.parse(message).mentions).toEqual([]);
    expect(messageSchema.parse({ ...message, mentions: [newId("agent")] }).mentions).toHaveLength(
      1,
    );
  });

  it("rejects unknown roles and bad ids", () => {
    expect(messageSchema.safeParse({ ...message, role: "bot" }).success).toBe(false);
    expect(messageSchema.safeParse({ ...message, id: "not-an-id" }).success).toBe(false);
  });
});

describe("artifactSchema", () => {
  const meta = {
    type: "doc",
    title: "Q3 Brief",
    x: 120,
    y: 120,
    w: 480,
    h: 400,
    createdAt: NOW,
  };

  it("accepts a doc artifact with a string body", () => {
    const artifact = { id: newId("artifact"), meta, body: "# Brief" };
    expect(artifactSchema.safeParse(artifact).success).toBe(true);
  });

  it("accepts a table artifact with a {cols, rows} body", () => {
    const artifact = {
      id: newId("artifact"),
      meta: { ...meta, type: "table", authorAgentId: newId("agent") },
      body: { cols: ["metric", "value"], rows: [{ metric: "MRR", value: "12k" }] },
    };
    expect(artifactSchema.safeParse(artifact).success).toBe(true);
  });

  it("rejects a body that does not match meta.type", () => {
    expect(
      artifactSchema.safeParse({
        id: newId("artifact"),
        meta,
        body: { cols: [], rows: [] },
      }).success,
    ).toBe(false);
    expect(
      artifactSchema.safeParse({
        id: newId("artifact"),
        meta: { ...meta, type: "table" },
        body: "text",
      }).success,
    ).toBe(false);
  });

  it("rejects non-positive sizes and unknown types", () => {
    expect(
      artifactSchema.safeParse({ id: newId("artifact"), meta: { ...meta, w: 0 }, body: "x" })
        .success,
    ).toBe(false);
    expect(
      artifactSchema.safeParse({
        id: newId("artifact"),
        meta: { ...meta, type: "diagram" },
        body: "x",
      }).success,
    ).toBe(false);
  });
});

describe("proposalSchema", () => {
  const base = {
    id: newId("proposal"),
    title: "Create Q3 Brief",
    summary: "New doc artifact",
    authorId: newId("agent"),
    authorKind: "agent",
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    status: "open",
  } as const;

  const payloads: ProposalInput[] = [
    {
      ...base,
      kind: "artifact_create",
      payload: {
        kind: "artifact_create",
        operation: { op: "artifact.create", type: "doc", title: "Q3 Brief", content: "…" },
      },
    },
    {
      ...base,
      kind: "artifact_patch",
      payload: {
        kind: "artifact_patch",
        operation: {
          op: "artifact.patch",
          artifactId: newId("artifact"),
          patch: [{ op: "replace", path: "/content", value: "new" }],
        },
      },
    },
    {
      ...base,
      kind: "agent_prompt",
      payload: { kind: "agent_prompt", targetAgentId: newId("agent"), content: "summarize" },
    },
    {
      ...base,
      kind: "publish_artifact",
      payload: { kind: "publish_artifact", artifactId: newId("artifact") },
    },
    {
      ...base,
      kind: "add_agent",
      payload: { kind: "add_agent", agentId: newId("agent"), name: "Writer", agentKind: "webhook" },
    },
    {
      ...base,
      kind: "remove_agent",
      payload: { kind: "remove_agent", agentId: newId("agent") },
    },
    {
      ...base,
      kind: "policy_change",
      payload: { kind: "policy_change", policy: { rule: "majority" } },
    },
    {
      ...base,
      kind: "invite_member",
      payload: { kind: "invite_member", role: "editor", email: "dana@example.com" },
    },
  ];

  it("accepts every payload kind", () => {
    for (const proposal of payloads) {
      const result = proposalSchema.safeParse(proposal);
      expect(result.success, `kind ${proposal.kind}`).toBe(true);
    }
  });

  it("defaults affectedArtifactIds to []", () => {
    const first = payloads[0];
    expect(first).toBeDefined();
    expect(proposalSchema.parse(first).affectedArtifactIds).toEqual([]);
  });

  it("rejects a payload whose kind does not match the proposal kind", () => {
    const mismatched = {
      ...base,
      kind: "artifact_create",
      payload: { kind: "remove_agent", agentId: newId("agent") },
    };
    expect(proposalSchema.safeParse(mismatched).success).toBe(false);
  });

  it("rejects unknown kinds and statuses", () => {
    const proposal = payloads[2];
    expect(proposal).toBeDefined();
    expect(proposalSchema.safeParse({ ...proposal, kind: "deploy" }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...proposal, status: "pending" }).success).toBe(false);
  });

  it("applies policy defaults inside a policy_change payload", () => {
    const parsed = proposalSchema.parse(payloads[6]);
    if (parsed.payload.kind !== "policy_change") throw new Error("wrong payload kind");
    expect(parsed.payload.policy).toEqual({ ...DEFAULT_POLICY, rule: "majority" });
  });
});

describe("vote schemas", () => {
  it("accepts approve/reject/abstain and nothing else", () => {
    for (const value of ["approve", "reject", "abstain"]) {
      expect(voteValueSchema.safeParse(value).success).toBe(true);
    }
    expect(voteValueSchema.safeParse("yes").success).toBe(false);
  });

  it("validates a votes-map entry", () => {
    expect(voteEntrySchema.safeParse({ value: "approve", at: NOW }).success).toBe(true);
    expect(voteEntrySchema.safeParse({ value: "approve" }).success).toBe(false);
  });

  it("validates a full audited vote record", () => {
    const vote = {
      id: newId("vote"),
      proposalId: newId("proposal"),
      boardId: newId("board"),
      memberId: newId("member"),
      value: "reject",
      createdAt: NOW,
    };
    expect(voteSchema.safeParse(vote).success).toBe(true);
    expect(voteSchema.safeParse({ ...vote, memberId: newId("user") }).success).toBe(false);
  });
});
