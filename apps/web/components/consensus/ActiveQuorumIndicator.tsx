"use client";

/**
 * How many members currently count toward consensus. When the number changes
 * (someone disconnects past the grace period, or rejoins) the chip visibly
 * flashes — quorum recalculation is SHOWN, never silent (CLAUDE.md §6).
 * aria-live announces the same change for screen readers.
 */
import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";

import { cn } from "@/lib/utils";

export function ActiveQuorumIndicator({ count }: { count: number }) {
  const previous = useRef(count);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (previous.current === count) return;
    previous.current = count;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 700);
    return () => clearTimeout(timer);
  }, [count]);

  return (
    <span
      role="status"
      aria-live="polite"
      title="Members counted toward consensus: connected now or seen in the last 5 minutes."
      className={cn(
        "inline-flex items-center gap-1 rounded-control border px-2 py-0.5 text-xs text-muted",
        flash && "animate-quorum-flash",
      )}
    >
      <Users aria-hidden className="size-3" />
      <span className="tabular-nums">{count}</span> voting
    </span>
  );
}
