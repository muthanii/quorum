"use client";

/**
 * One chip per potential voter on a proposal: identity color + name + their
 * standing vote. Inactive (away) members stay visible but dimmed — their vote
 * is kept and re-counts on rejoin. Color is never the only signal: every chip
 * carries the name and a labeled vote icon.
 */
import { Check, Clock, Minus, X } from "lucide-react";

import type { VoteChip } from "@/lib/consensus/vote-state";
import { cn } from "@/lib/utils";

const VOTE_ICONS = {
  approve: { Icon: Check, label: "approved", className: "text-success" },
  reject: { Icon: X, label: "rejected", className: "text-danger" },
  abstain: { Icon: Minus, label: "abstained", className: "text-muted" },
  pending: { Icon: Clock, label: "has not voted", className: "text-faint" },
} as const;

export function VoteChips({ chips }: { chips: VoteChip[] }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Votes by member">
      {chips.map((chip) => {
        const vote = VOTE_ICONS[chip.value];
        return (
          <li
            key={chip.memberId}
            className={cn(
              "inline-flex items-center gap-1 rounded-control border bg-raised px-1.5 py-0.5 text-[11px]",
              !chip.active && "opacity-55",
            )}
            style={{ borderColor: chip.color }}
          >
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: chip.color }}
            />
            <span className="max-w-24 truncate">{chip.name}</span>
            <vote.Icon aria-hidden className={cn("size-3 shrink-0", vote.className)} />
            <span className="sr-only">{vote.label}</span>
            {!chip.active ? <span className="text-faint">away</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
