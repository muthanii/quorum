"use client";

/**
 * A ticking clock for countdowns and quorum windows. One interval per caller;
 * coarse (default 1s) so re-renders stay cheap. Never use inside pure logic —
 * pass the value down so view-models stay clock-free.
 */
import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
