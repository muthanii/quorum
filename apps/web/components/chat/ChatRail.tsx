"use client";

/**
 * The right-hand rail: one chronological thread of chat messages and
 * proposal cards (proposals are never only in one place — the affected
 * artifact simultaneously shows a dashed outline on the canvas). Sticks to
 * the bottom while the reader is at the bottom; stays put while they scroll
 * history.
 */
import { useEffect, useMemo, useRef } from "react";

import type { Message } from "@quorum/shared/schemas/message";
import type { VoteValue } from "@quorum/shared/schemas/vote";
import type { ProposalWithVotes } from "@quorum/shared/yjs/doc";

import { MessageItem } from "@/components/chat/MessageItem";
import { ProposalCard, type ConsensusContext } from "@/components/chat/ProposalCard";
import { ScrollArea } from "@/components/ui/scroll-area";

const STICK_THRESHOLD_PX = 80;

export interface ChatRailProps {
  messages: Message[];
  proposals: ProposalWithVotes[];
  consensus: ConsensusContext;
  /** Resolves a proposal author id (usr_/agt_) to a display name. */
  authorName: (proposal: ProposalWithVotes) => string;
  onVote: (proposalId: string, value: VoteValue) => void;
  typingNames: string[];
  synced: boolean;
}

type TimelineItem =
  | { kind: "message"; at: number; message: Message }
  | { kind: "proposal"; at: number; proposal: ProposalWithVotes };

export function ChatRail({
  messages,
  proposals,
  consensus,
  authorName,
  onVote,
  typingNames,
  synced,
}: ChatRailProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const stickRef = useRef(true);

  const items = useMemo<TimelineItem[]>(() => {
    const list: TimelineItem[] = [
      ...messages.map((message) => ({ kind: "message" as const, at: message.createdAt, message })),
      ...proposals.map((proposal) => ({
        kind: "proposal" as const,
        at: proposal.createdAt,
        proposal,
      })),
    ];
    list.sort((a, b) => a.at - b.at);
    return list;
  }, [messages, proposals]);

  const viewport = () =>
    rootRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

  useEffect(() => {
    const el = viewport();
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = viewport();
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <aside
      ref={rootRef}
      aria-label="Chat and proposals"
      className="flex min-h-0 w-full flex-1 flex-col border-t bg-background md:w-[360px] md:flex-none md:shrink-0 md:border-t-0 md:border-l"
    >
      <ScrollArea className="min-h-0 flex-1">
        <ol className="flex flex-col gap-3 p-4">
          {items.length === 0 ? (
            <li className="text-xs text-faint">
              {synced
                ? "No messages yet — say hi, or @mention an agent."
                : "Loading the conversation…"}
            </li>
          ) : (
            items.map((item) =>
              item.kind === "message" ? (
                <li key={item.message.id}>
                  <MessageItem message={item.message} />
                </li>
              ) : (
                <li key={item.proposal.id}>
                  <ProposalCard
                    proposal={item.proposal}
                    authorName={authorName(item.proposal)}
                    consensus={consensus}
                    onVote={onVote}
                  />
                </li>
              ),
            )
          )}
        </ol>
      </ScrollArea>
      {typingNames.length > 0 ? (
        <p className="border-t px-4 py-1.5 text-[11px] text-faint" role="status" aria-live="polite">
          {typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing…
        </p>
      ) : null}
    </aside>
  );
}
