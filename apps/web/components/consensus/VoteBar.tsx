"use client";

/**
 * Animated approval tally for an open proposal. The width transition makes
 * live votes visibly move the bar for everyone (prefers-reduced-motion users
 * get the numbers without the sweep — the global reset kills transitions).
 */
import type { VoteTally } from "@/lib/consensus/vote-state";

export function VoteBar({ tally }: { tally: VoteTally }) {
  const pct = tally.needed === 0 ? 0 : Math.min(100, (tally.approved / tally.needed) * 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[11px] text-muted">
        <span className="tabular-nums">
          {tally.approved}/{tally.needed} approvals
        </span>
        <span className="tabular-nums">{tally.total} active</span>
      </div>
      <div
        role="progressbar"
        aria-label="Approvals"
        aria-valuemin={0}
        aria-valuemax={tally.needed}
        aria-valuenow={tally.approved}
        className="h-1 overflow-hidden rounded-full bg-raised"
      >
        <div
          className="h-full rounded-full bg-success transition-[width] duration-(--duration-base) ease-standard"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
