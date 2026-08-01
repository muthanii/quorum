"use client";

/**
 * A proposal, inline in the chat rail — the same state the affected artifact
 * shows as a dashed outline on the canvas. Voting is one click (never a
 * modal) or one key: A approves, R rejects while the card is focused. The
 * view-model (chips, tally, countdown, canVote) comes from the pure
 * vote-state projection; the ws server stays the sole authority on the
 * actual resolution, which lands here as an applied/rejected/expired state
 * with a visible explanation — never a silent rollback.
 */
import { Check, Clock, X } from "lucide-react";

import type { ProposalKind } from "@quorum/shared/schemas/proposal";
import type { ConsensusPolicy } from "@quorum/shared/schemas/policy";
import type { VoteValue } from "@quorum/shared/schemas/vote";
import type { ProposalWithVotes } from "@quorum/shared/yjs/doc";

import { VoteBar } from "@/components/consensus/VoteBar";
import { VoteChips } from "@/components/consensus/VoteChips";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { buildVoteState, type VoteMemberInfo } from "@/lib/consensus/vote-state";
import { cn } from "@/lib/utils";

/** Everything the vote view-model needs, assembled once by the board shell. */
export interface ConsensusContext {
  members: VoteMemberInfo[];
  activeMemberIds: readonly string[];
  policy: ConsensusPolicy;
  /** Board owner's user id (rule "owner_only" cannot resolve without it). */
  ownerId: string;
  /** The local user's id — the vote key they may write. */
  selfId: string;
  /** Ticking clock injected from above; components never read Date.now(). */
  now: number;
}

export interface ProposalCardProps {
  proposal: ProposalWithVotes;
  authorName: string;
  consensus: ConsensusContext;
  onVote: (proposalId: string, value: VoteValue) => void;
}

const KIND_LABELS: Record<ProposalKind, string> = {
  artifact_create: "New artifact",
  artifact_patch: "Edit artifact",
  agent_prompt: "Agent prompt",
  publish_artifact: "Publish",
  add_agent: "Add agent",
  remove_agent: "Remove agent",
  policy_change: "Policy change",
  invite_member: "Member access",
};

function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function resolvedNote(
  proposal: ProposalWithVotes,
  members: VoteMemberInfo[],
): { className: string; text: string } | null {
  switch (proposal.status) {
    case "applied":
      return {
        className: "text-success",
        text: "Approved — the change was applied to the board.",
      };
    case "rejected": {
      const latestReject = Object.entries(proposal.votes)
        .filter(([, vote]) => vote.value === "reject")
        .sort((a, b) => b[1].at - a[1].at)[0];
      const name = latestReject
        ? (members.find((member) => member.id === latestReject[0])?.name ?? "a member")
        : null;
      return {
        className: "text-danger",
        text: name
          ? `Rejected — ${name} voted no. Nothing was applied.`
          : "Rejected. Nothing was applied.",
      };
    }
    case "expired":
      return {
        className: "text-muted",
        text: "Expired without consensus — nothing was applied. Timeouts never auto-approve.",
      };
    case "open":
      return null;
  }
}

export function ProposalCard({ proposal, authorName, consensus, onVote }: ProposalCardProps) {
  const vm = buildVoteState({
    proposal,
    votes: proposal.votes,
    members: consensus.members,
    activeMemberIds: consensus.activeMemberIds,
    policy: consensus.policy,
    now: consensus.now,
    selfMemberId: consensus.selfId,
    ownerMemberId: consensus.ownerId,
  });

  const isOpen = proposal.status === "open";
  const note = resolvedNote(proposal, consensus.members);
  const selfVote = proposal.votes[consensus.selfId]?.value;

  return (
    <article
      tabIndex={0}
      aria-label={`Proposal: ${proposal.title}`}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (!vm.canVote) return;
        const key = event.key.toLowerCase();
        if (key === "a") {
          event.preventDefault();
          onVote(proposal.id, "approve");
        } else if (key === "r") {
          event.preventDefault();
          onVote(proposal.id, "reject");
        }
      }}
      className={cn(
        "rounded-panel border bg-surface p-3 shadow-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        isOpen && "border-warning/60",
      )}
    >
      <div className="flex items-center gap-2">
        <Badge variant={isOpen ? "warning" : "secondary"}>{KIND_LABELS[proposal.kind]}</Badge>
        <span className="truncate text-[11px] text-faint">by {authorName}</span>
        {isOpen ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-muted tabular-nums">
            <Clock aria-hidden className="size-3" />
            {formatRemaining(vm.msRemaining)} left
          </span>
        ) : null}
      </div>

      <h4 className="mt-1.5 text-ui font-medium">{proposal.title}</h4>
      {proposal.summary !== "" ? (
        <p className="mt-0.5 text-xs text-muted">{proposal.summary}</p>
      ) : null}

      {isOpen ? (
        <>
          <div className="mt-2">
            <VoteBar tally={vm.tally} />
          </div>
          <div className="mt-2">
            <VoteChips chips={vm.chips} />
          </div>
          {vm.waitingOnNames.length > 0 ? (
            <p className="mt-1 text-[11px] text-faint">Waiting on {vm.waitingOnNames.join(", ")}</p>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              disabled={!vm.canVote}
              aria-keyshortcuts="a"
              onClick={() => onVote(proposal.id, "approve")}
            >
              <Check aria-hidden />
              Approve
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!vm.canVote}
              aria-keyshortcuts="r"
              onClick={() => onVote(proposal.id, "reject")}
            >
              <X aria-hidden />
              Reject
            </Button>
            <span className="ml-auto text-[10px] text-faint">
              <Kbd>A</Kbd> / <Kbd>R</Kbd>
            </span>
          </div>
          {selfVote !== undefined ? (
            <p role="status" className="mt-1.5 text-[11px] text-muted">
              You voted {selfVote === "approve" ? "approve" : selfVote} — you can change it while
              the vote is open.
            </p>
          ) : null}
        </>
      ) : note ? (
        <p role="status" className={cn("mt-2 text-xs", note.className)}>
          {note.text}
        </p>
      ) : null}
    </article>
  );
}
