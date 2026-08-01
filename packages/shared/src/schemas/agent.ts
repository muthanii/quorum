import { z } from "zod";

import { idSchema } from "../ids";

export const AGENT_KINDS = ["webhook", "model"] as const;

export const agentKindSchema = z.enum(AGENT_KINDS);

export type AgentKind = z.infer<typeof agentKindSchema>;

export const AGENT_STATUSES = ["ready", "running", "degraded"] as const;

export const agentStatusSchema = z.enum(AGENT_STATUSES);

export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * A connected agent as it may be shown to clients. Credentials NEVER appear
 * here — not encrypted, not truncated. Only the display-safe maskedKey
 * suffix. `.strict()` so a raw key smuggled in an extra field fails loudly.
 */
export const agentSchema = z
  .object({
    id: idSchema("agent"),
    boardId: idSchema("board"),
    /** The board member who plugged this agent in. */
    ownerMemberId: idSchema("member"),
    name: z.string().min(1).max(80),
    kind: agentKindSchema,
    /** Webhook URL, or the model provider's base URL for kind "model". */
    endpoint: z.string().url(),
    /** Model name to call — only meaningful for kind "model". */
    model: z.string().min(1).max(120).optional(),
    /** Display-safe suffix like "…abc4"; null when no credential is stored. */
    maskedKey: z.string().max(16).nullable(),
    status: agentStatusSchema,
    /** Unix epoch milliseconds. */
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type Agent = z.infer<typeof agentSchema>;

/** Live roster entry stored in the Y.Doc "agentStatus" map (agentId → this). */
export const agentStatusEntrySchema = z.object({
  status: agentStatusSchema,
  /** Unix epoch ms of the last status change. */
  at: z.number().int().nonnegative(),
});

export type AgentStatusEntry = z.infer<typeof agentStatusEntrySchema>;
