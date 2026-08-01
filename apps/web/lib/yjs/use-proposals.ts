"use client";

/**
 * Live proposals + vote tallies from the Y.Doc "proposals" map, with a
 * castVote bound to the local member. Clients write ONLY their own key in a
 * proposal's votes map; the ws server is the sole authority on resolution.
 *
 * Member/vote key space: the same usr_ id the ws token carries as `sub` —
 * BoardSelf.id. The engine only requires that votes, activeMemberIds, and
 * human proposal authorIds share one id space, and web-side that space is
 * the user id.
 */
import { useCallback, useMemo } from "react";
import type * as Y from "yjs";

import type { VoteValue } from "@quorum/shared/schemas/vote";
import {
  castVote,
  getProposals,
  readProposal,
  type ProposalWithVotes,
} from "@quorum/shared/yjs/doc";

import { useYSnapshot } from "./use-y-snapshot";

const EMPTY_PROPOSALS: ProposalWithVotes[] = [];

export interface UseProposalsResult {
  /** All proposals in the doc (open and resolved), oldest first. */
  proposals: ProposalWithVotes[];
  /** Cast/replace the local member's vote. False when it could not be recorded. */
  castVote: (proposalId: string, value: VoteValue) => boolean;
}

export function useProposals(doc: Y.Doc | null, selfMemberId: string | null): UseProposalsResult {
  const map = useMemo(() => (doc ? getProposals(doc) : null), [doc]);

  const proposals = useYSnapshot(
    map,
    () => {
      if (!doc || !map) return EMPTY_PROPOSALS;
      const list: ProposalWithVotes[] = [];
      map.forEach((_value, proposalId) => {
        const proposal = readProposal(doc, proposalId);
        if (proposal) list.push(proposal);
      });
      list.sort((a, b) => a.createdAt - b.createdAt);
      return list;
    },
    EMPTY_PROPOSALS,
  );

  const boundCastVote = useCallback(
    (proposalId: string, value: VoteValue): boolean => {
      if (!doc || selfMemberId === null) return false;
      return castVote(doc, proposalId, selfMemberId, value, Date.now());
    },
    [doc, selfMemberId],
  );

  return { proposals, castVote: boundCastVote };
}
