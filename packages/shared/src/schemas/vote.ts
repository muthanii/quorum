import { z } from "zod";

import { idSchema } from "../ids";

export const VOTE_VALUES = ["approve", "reject", "abstain"] as const;

export const voteValueSchema = z.enum(VOTE_VALUES);

export type VoteValue = z.infer<typeof voteValueSchema>;

/**
 * The per-member entry inside a proposal's `votes` Y.Map (memberId → this).
 * Clients only ever write their own key.
 */
export const voteEntrySchema = z.object({
  value: voteValueSchema,
  /** Unix epoch milliseconds. */
  at: z.number().int().nonnegative(),
});

export type VoteEntry = z.infer<typeof voteEntrySchema>;

/** The immutable audited vote record (Postgres, append-only). */
export const voteSchema = z.object({
  id: idSchema("vote"),
  proposalId: idSchema("proposal"),
  boardId: idSchema("board"),
  memberId: idSchema("member"),
  value: voteValueSchema,
  /** Unix epoch milliseconds. */
  createdAt: z.number().int().nonnegative(),
});

export type Vote = z.infer<typeof voteSchema>;
