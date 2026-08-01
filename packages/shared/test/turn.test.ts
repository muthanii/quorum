import { describe, expect, it } from "vitest";
import type { AgentResponse, TurnPayload } from "@quorum/agent-protocol/v1/types";

import {
  MAX_AGENT_RESPONSE_BYTES,
  agentResponseSchema,
  jsonPatchOpSchema,
  turnPayloadSchema,
} from "../src/schemas/turn";

// Typed as the wire contract on purpose: if the schema and the published
// types drift apart, this file stops compiling.
const payload: TurnPayload = {
  turnId: "trn_V1StGXR8_Z5jdHi6",
  boardId: "brd_V1StGXR8_Z5jdHi6",
  agent: { id: "agt_V1StGXR8_Z5jdHi6", name: "Researcher" },
  trigger: { type: "mention" },
  context: {
    messages: [
      { role: "human", authorId: "usr_V1StGXR8_Z5jdHi6", name: "Dana", content: "@Researcher go" },
      { role: "agent", authorId: "agt_V1StGXR8_Z5jdHi6", name: "Researcher", content: "On it." },
    ],
    artifacts: [{ id: "art_V1StGXR8_Z5jdHi6", type: "doc", title: "Brief", content: "…" }],
    openProposals: [
      {
        id: "prp_V1StGXR8_Z5jdHi6",
        kind: "artifact.patch",
        title: "Edit brief",
        summary: "Tighten intro",
        authorId: "agt_V1StGXR8_Z5jdHi6",
        authorKind: "agent",
        createdAt: 1_753_400_000_000,
        expiresAt: 1_753_400_300_000,
      },
    ],
  },
  capabilities: ["message", "artifact.create", "artifact.patch", "proposal.create"],
};

describe("MAX_AGENT_RESPONSE_BYTES", () => {
  it("is 1 MiB", () => {
    expect(MAX_AGENT_RESPONSE_BYTES).toBe(1_048_576);
  });
});

describe("turnPayloadSchema", () => {
  it("accepts a full valid payload unchanged", () => {
    expect(turnPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("rejects unknown trigger types and capabilities", () => {
    expect(turnPayloadSchema.safeParse({ ...payload, trigger: { type: "cron" } }).success).toBe(
      false,
    );
    expect(turnPayloadSchema.safeParse({ ...payload, capabilities: ["shell"] }).success).toBe(
      false,
    );
  });

  it("rejects a missing context section", () => {
    const { context: _context, ...rest } = payload;
    expect(turnPayloadSchema.safeParse(rest).success).toBe(false);
  });
});

describe("agentResponseSchema", () => {
  it("accepts an empty response (both fields optional)", () => {
    expect(agentResponseSchema.safeParse({}).success).toBe(true);
  });

  it("accepts messages plus all three operation kinds", () => {
    const response: AgentResponse = {
      messages: [{ content: "Here's a first pass at the brief." }],
      operations: [
        { op: "artifact.create", type: "doc", title: "Q3 Brief", content: "# Q3" },
        {
          op: "artifact.patch",
          artifactId: "art_V1StGXR8_Z5jdHi6",
          patch: [{ op: "replace", path: "/content", value: "# Q3 v2" }],
        },
        {
          op: "proposal.create",
          title: "Ask the writer",
          summary: "Hand off to Writer",
          prompt: { targetAgentId: "agt_V1StGXR8_Z5jdHi6", content: "polish this" },
        },
        {
          op: "proposal.create",
          title: "New table",
          summary: "Metrics table",
          operation: { op: "artifact.create", type: "table", title: "KPIs", content: "{}" },
        },
      ],
    };
    expect(agentResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects unknown operations", () => {
    expect(
      agentResponseSchema.safeParse({ operations: [{ op: "shell.exec", cmd: "rm -rf /" }] })
        .success,
    ).toBe(false);
  });

  it("rejects artifact.patch with an empty or malformed patch", () => {
    expect(
      agentResponseSchema.safeParse({
        operations: [{ op: "artifact.patch", artifactId: "art_x", patch: [] }],
      }).success,
    ).toBe(false);
    expect(
      agentResponseSchema.safeParse({
        operations: [{ op: "artifact.patch", artifactId: "art_x", patch: [{ op: "explode" }] }],
      }).success,
    ).toBe(false);
  });

  it("requires exactly one of operation|prompt on proposal.create", () => {
    const base = { op: "proposal.create", title: "T", summary: "S" };
    expect(agentResponseSchema.safeParse({ operations: [base] }).success).toBe(false);
    expect(
      agentResponseSchema.safeParse({
        operations: [
          {
            ...base,
            operation: { op: "artifact.create", type: "doc", title: "D", content: "" },
            prompt: { targetAgentId: "agt_x", content: "hi" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("jsonPatchOpSchema", () => {
  it("accepts all six RFC 6902 op kinds", () => {
    const ops = [
      { op: "add", path: "/rows/-", value: { a: "1" } },
      { op: "remove", path: "/rows/0" },
      { op: "replace", path: "/title", value: "New" },
      { op: "move", from: "/rows/0", path: "/rows/1" },
      { op: "copy", from: "/rows/0", path: "/rows/-" },
      { op: "test", path: "/title", value: "Old" },
    ];
    for (const op of ops) {
      expect(jsonPatchOpSchema.safeParse(op).success, op.op).toBe(true);
    }
  });

  it("rejects ops missing their required fields", () => {
    expect(jsonPatchOpSchema.safeParse({ op: "add", path: "/x" }).success).toBe(false);
    expect(jsonPatchOpSchema.safeParse({ op: "move", path: "/x" }).success).toBe(false);
    expect(jsonPatchOpSchema.safeParse({ op: "nope", path: "/x" }).success).toBe(false);
  });
});
