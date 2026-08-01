"use client";

/**
 * Visually-hidden live region announcing newly staged proposals to assistive
 * tech (WCAG: the proposal card appearing in the rail is otherwise a purely
 * visual event). Proposals present at mount are not announced.
 */
import { useEffect, useRef, useState } from "react";

import type { ProposalWithVotes } from "@quorum/shared/yjs/doc";

export function ProposalAnnouncer({ proposals }: { proposals: ProposalWithVotes[] }) {
  const known = useRef<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (known.current === null) {
      known.current = new Set(proposals.map((p) => p.id));
      return;
    }
    const fresh = proposals.filter((p) => p.status === "open" && !known.current?.has(p.id));
    for (const proposal of proposals) known.current.add(proposal.id);
    const latest = fresh[fresh.length - 1];
    if (latest) {
      setAnnouncement(
        `New proposal: ${latest.title}. Vote in the chat rail — press A to approve or R to reject while it is focused.`,
      );
    }
  }, [proposals]);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  );
}
