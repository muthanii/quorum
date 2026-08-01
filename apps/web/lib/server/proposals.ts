/**
 * Server-side proposal construction. REST handlers cannot write the Y.Doc
 * (only ws-connected clients and the ws server hold it), so handlers return
 * a fully-validated Proposal and the CLIENT stages it with
 * createProposalInDoc(doc, proposal). The ws server then owns resolution.
 */
import { newId } from "@quorum/shared/ids";
import type { ConsensusPolicy } from "@quorum/shared/schemas/policy";
import {
  proposalSchema,
  type Proposal,
  type ProposalPayload,
} from "@quorum/shared/schemas/proposal";

export function buildHumanProposal(input: {
  title: string;
  summary: string;
  /** usr_… — the doc-wide member/vote key space (ws maps ids when auditing). */
  authorId: string;
  payload: ProposalPayload;
  policy: ConsensusPolicy;
  now: number;
  affectedArtifactIds?: string[];
}): Proposal {
  // Parse rather than cast: guarantees payload/kind coherence and gives the
  // client an object createProposalInDoc will accept verbatim.
  return proposalSchema.parse({
    id: newId("proposal"),
    kind: input.payload.kind,
    title: input.title,
    summary: input.summary,
    authorId: input.authorId,
    authorKind: "human",
    createdAt: input.now,
    expiresAt: input.now + input.policy.timeoutMs,
    status: "open",
    payload: input.payload,
    affectedArtifactIds: input.affectedArtifactIds ?? [],
  });
}
