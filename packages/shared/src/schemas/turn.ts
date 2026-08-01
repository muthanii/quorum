/**
 * Zod validators for the Agent Protocol v1 wire types. The `z.ZodType<T>`
 * annotations pin each schema to the exact shape in
 * `@quorum/agent-protocol/v1/types` — if the contract and these schemas
 * drift, this file stops compiling.
 */
import { z } from "zod";
import type {
  AgentCapability,
  AgentMessage,
  AgentOperation,
  AgentResponse,
  ArtifactCreateOperation,
  ArtifactPatchOperation,
  JsonPatchOp,
  JsonValue,
  ProposalCreateOperation,
  ProposalPromptTarget,
  TriggerType,
  TurnArtifact,
  TurnContext,
  TurnMessage,
  TurnOpenProposal,
  TurnPayload,
} from "@quorum/agent-protocol/v1/types";

/** Hard cap on an agent's HTTP response body. Larger responses are dropped. */
export const MAX_AGENT_RESPONSE_BYTES = 1024 * 1024;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const jsonPatchOpSchema: z.ZodType<JsonPatchOp> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: z.string(), value: jsonValueSchema }),
  z.object({ op: z.literal("remove"), path: z.string() }),
  z.object({ op: z.literal("replace"), path: z.string(), value: jsonValueSchema }),
  z.object({ op: z.literal("move"), from: z.string(), path: z.string() }),
  z.object({ op: z.literal("copy"), from: z.string(), path: z.string() }),
  z.object({ op: z.literal("test"), path: z.string(), value: jsonValueSchema }),
]);

export const agentCapabilitySchema: z.ZodType<AgentCapability> = z.enum([
  "message",
  "artifact.create",
  "artifact.patch",
  "proposal.create",
]);

export const triggerTypeSchema: z.ZodType<TriggerType> = z.enum([
  "mention",
  "broadcast",
  "proposal_approved",
  "schedule",
]);

export const turnMessageSchema: z.ZodType<TurnMessage> = z.object({
  role: z.enum(["human", "agent"]),
  authorId: z.string().min(1),
  name: z.string(),
  content: z.string(),
});

export const turnArtifactSchema: z.ZodType<TurnArtifact> = z.object({
  id: z.string().min(1),
  type: z.enum(["doc", "table"]),
  title: z.string(),
  content: z.string(),
});

export const turnOpenProposalSchema: z.ZodType<TurnOpenProposal> = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  authorId: z.string().min(1),
  authorKind: z.enum(["human", "agent"]),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export const turnContextSchema: z.ZodType<TurnContext> = z.object({
  messages: z.array(turnMessageSchema),
  artifacts: z.array(turnArtifactSchema),
  openProposals: z.array(turnOpenProposalSchema),
});

export const turnPayloadSchema: z.ZodType<TurnPayload> = z.object({
  turnId: z.string().min(1),
  boardId: z.string().min(1),
  agent: z.object({ id: z.string().min(1), name: z.string() }),
  trigger: z.object({ type: triggerTypeSchema }),
  context: turnContextSchema,
  capabilities: z.array(agentCapabilitySchema),
});

export const artifactCreateOperationSchema: z.ZodType<ArtifactCreateOperation> = z.object({
  op: z.literal("artifact.create"),
  type: z.enum(["doc", "table"]),
  title: z.string().min(1),
  content: z.string(),
});

export const artifactPatchOperationSchema: z.ZodType<ArtifactPatchOperation> = z.object({
  op: z.literal("artifact.patch"),
  artifactId: z.string().min(1),
  patch: z.array(jsonPatchOpSchema).min(1),
});

export const proposalPromptTargetSchema: z.ZodType<ProposalPromptTarget> = z.object({
  targetAgentId: z.string().min(1),
  content: z.string().min(1),
});

/**
 * The wire type leaves `operation` and `prompt` both optional; semantically a
 * proposal.create must carry exactly one of them, so the refinement enforces
 * that.
 */
export const proposalCreateOperationSchema: z.ZodType<ProposalCreateOperation> = z
  .object({
    op: z.literal("proposal.create"),
    title: z.string().min(1),
    summary: z.string(),
    operation: z.union([artifactCreateOperationSchema, artifactPatchOperationSchema]).optional(),
    prompt: proposalPromptTargetSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasOperation = value.operation !== undefined;
    const hasPrompt = value.prompt !== undefined;
    if (hasOperation === hasPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "proposal.create requires exactly one of `operation` or `prompt`",
      });
    }
  });

export const agentOperationSchema: z.ZodType<AgentOperation> = z.union([
  artifactCreateOperationSchema,
  artifactPatchOperationSchema,
  proposalCreateOperationSchema,
]);

export const agentMessageSchema: z.ZodType<AgentMessage> = z.object({
  content: z.string(),
});

export const agentResponseSchema: z.ZodType<AgentResponse> = z.object({
  messages: z.array(agentMessageSchema).optional(),
  operations: z.array(agentOperationSchema).optional(),
});
