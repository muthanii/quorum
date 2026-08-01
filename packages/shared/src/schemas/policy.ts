import { z } from "zod";

/**
 * Board consensus policy. Defaults are CLAUDE.md §6 verbatim — unanimous,
 * active quorum, 5-minute expiry, never auto-approve. Changing the policy is
 * itself a unanimous proposal.
 */

export const CONSENSUS_RULES = ["unanimous", "majority", "owner_only", "threshold"] as const;

export const consensusRuleSchema = z.enum(CONSENSUS_RULES);

export type ConsensusRule = z.infer<typeof consensusRuleSchema>;

export const DEFAULT_PROPOSAL_TIMEOUT_MS = 5 * 60 * 1000;

export const policySchema = z
  .object({
    rule: consensusRuleSchema.default("unanimous"),
    /** Approvals required when rule is "threshold"; must be set for that rule. */
    thresholdN: z.number().int().min(1).optional(),
    /** Only "active" exists: members connected now OR seen in the last 5 min. */
    quorum: z.literal("active").default("active"),
    timeoutMs: z.number().int().positive().default(DEFAULT_PROPOSAL_TIMEOUT_MS),
    /** Expiry never auto-approves — "reject" is the only allowed outcome. */
    onTimeout: z.literal("reject").default("reject"),
    /** One reject resolves the proposal immediately. */
    vetoIsFinal: z.boolean().default(true),
    /** A human proposer must still explicitly approve their own proposal. */
    autoApproveOwnProposals: z.boolean().default(false),
  })
  .superRefine((policy, ctx) => {
    if (policy.rule === "threshold" && policy.thresholdN === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thresholdN"],
        message: 'rule "threshold" requires thresholdN',
      });
    }
  });

export type ConsensusPolicy = z.infer<typeof policySchema>;
export type ConsensusPolicyInput = z.input<typeof policySchema>;

export const DEFAULT_POLICY: ConsensusPolicy = policySchema.parse({});
