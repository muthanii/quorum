/**
 * TEST-ONLY window hook for the Playwright suite in e2e/. It exposes thin,
 * zod-validated helpers over the live Y.Doc so a test can do exactly what a
 * connected agent's turn would do — STAGE a proposal — without running an
 * agent server. Nothing here votes, resolves, or applies: staging is the
 * consensus pipeline's entry point and the ws server stays the sole
 * authority on resolution (CLAUDE.md §6).
 *
 * The hook installs only outside production builds — Next.js inlines
 * process.env.NODE_ENV client-side, so the whole body is dead code (and the
 * global stays undefined) in a production bundle.
 */
import type * as Y from "yjs";

import { newId, type IdKind } from "@quorum/shared/ids";
import type { Artifact } from "@quorum/shared/schemas/artifact";
import type { Proposal, ProposalInput } from "@quorum/shared/schemas/proposal";
import { createProposalInDoc, getArtifacts, readArtifact } from "@quorum/shared/yjs/doc";

export type StageProposalInput = Omit<
  ProposalInput,
  "id" | "createdAt" | "expiresAt" | "status"
> & {
  /** Vote window in ms; defaults to the product's 5-minute policy timeout. */
  timeoutMs?: number;
};

export interface QuorumE2EHook {
  /** Stage a proposal in the doc (status "open"); returns the parsed proposal. */
  stageProposal(input: StageProposalInput): Proposal;
  /** Plain-JSON snapshot of every artifact currently in the doc. */
  listArtifacts(): Artifact[];
  /** Mint a prefixed id (e.g. a syntactically valid agt_… author id). */
  newId(kind: IdKind): string;
}

declare global {
  interface Window {
    __quorumE2E?: QuorumE2EHook;
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Install (doc connected) or remove (doc torn down) the window hook. */
export function installE2EHook(doc: Y.Doc | null): void {
  if (process.env.NODE_ENV === "production") return;
  if (typeof window === "undefined") return;
  if (doc === null) {
    delete window.__quorumE2E;
    return;
  }
  window.__quorumE2E = {
    stageProposal(input) {
      const { timeoutMs, ...proposal } = input;
      const now = Date.now();
      return createProposalInDoc(doc, {
        ...proposal,
        id: newId("proposal"),
        createdAt: now,
        expiresAt: now + (timeoutMs ?? DEFAULT_TIMEOUT_MS),
        status: "open",
      });
    },
    listArtifacts() {
      const artifacts: Artifact[] = [];
      getArtifacts(doc).forEach((_value, artifactId) => {
        const artifact = readArtifact(doc, artifactId);
        if (artifact !== null) artifacts.push(artifact);
      });
      return artifacts;
    },
    newId,
  };
}
