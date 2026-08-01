import { z } from "zod";

import { idSchema } from "../ids";
import { agentKindSchema } from "./agent";
import { policySchema } from "./policy";
import { artifactCreateOperationSchema, artifactPatchOperationSchema } from "./turn";

export const PROPOSAL_KINDS = [
  "artifact_create",
  "artifact_patch",
  "agent_prompt",
  "publish_artifact",
  "add_agent",
  "remove_agent",
  "policy_change",
  "invite_member",
] as const;

export const proposalKindSchema = z.enum(PROPOSAL_KINDS);

export type ProposalKind = z.infer<typeof proposalKindSchema>;

export const PROPOSAL_STATUSES = ["open", "applied", "rejected", "expired"] as const;

export const proposalStatusSchema = z.enum(PROPOSAL_STATUSES);

export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalAuthorKindSchema = z.enum(["human", "agent"]);

export type ProposalAuthorKind = z.infer<typeof proposalAuthorKindSchema>;

/**
 * The staged operation carried by a proposal — plain JSON in the Y.Doc,
 * discriminated by the same `kind` as the proposal itself. This is what gets
 * applied (atomically) if and only if the vote passes.
 *
 * add_agent deliberately carries only the agent's id + display fields:
 * credentials go straight to Postgres encrypted and must NEVER enter the
 * Y.Doc, which every board member can read.
 */
export const proposalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact_create"), operation: artifactCreateOperationSchema }),
  z.object({ kind: z.literal("artifact_patch"), operation: artifactPatchOperationSchema }),
  z.object({
    kind: z.literal("agent_prompt"),
    targetAgentId: idSchema("agent"),
    content: z.string().min(1),
  }),
  z.object({ kind: z.literal("publish_artifact"), artifactId: idSchema("artifact") }),
  z.object({
    kind: z.literal("add_agent"),
    agentId: idSchema("agent"),
    name: z.string().min(1).max(80),
    agentKind: agentKindSchema,
  }),
  z.object({ kind: z.literal("remove_agent"), agentId: idSchema("agent") }),
  z.object({ kind: z.literal("policy_change"), policy: policySchema }),
  z.object({
    kind: z.literal("invite_member"),
    /** Viewers never need a proposal — only editor-or-above invites do. */
    role: z.enum(["editor", "owner"]),
    email: z.string().email().optional(),
  }),
]);

export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;

export const proposalSchema = z
  .object({
    id: idSchema("proposal"),
    kind: proposalKindSchema,
    title: z.string().min(1).max(200),
    summary: z.string(),
    /** usr_… for humans, agt_… for agents (see authorKind). */
    authorId: z.string().min(1),
    authorKind: proposalAuthorKindSchema,
    /** Unix epoch milliseconds. */
    createdAt: z.number().int().nonnegative(),
    /** Unix epoch milliseconds — createdAt + policy.timeoutMs. */
    expiresAt: z.number().int().nonnegative(),
    status: proposalStatusSchema,
    payload: proposalPayloadSchema,
    /** Drives the dashed outline on affected artifacts while the vote is open. */
    affectedArtifactIds: z.array(idSchema("artifact")).default([]),
  })
  .superRefine((proposal, ctx) => {
    if (proposal.payload.kind !== proposal.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "kind"],
        message: `payload kind "${proposal.payload.kind}" must match proposal kind "${proposal.kind}"`,
      });
    }
  });

export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalInput = z.input<typeof proposalSchema>;
