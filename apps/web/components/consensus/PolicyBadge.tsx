"use client";

/**
 * Persistent header badge for the board's consensus rule. Quiet when the rule
 * is the default (unanimous); a warning badge whenever it is anything else —
 * the board header must always show a relaxed policy (CLAUDE.md §6).
 */
import { AlertTriangle } from "lucide-react";

import type { ConsensusPolicy } from "@quorum/shared/schemas/policy";

import { Badge } from "@/components/ui/badge";

function policyLabel(policy: ConsensusPolicy): string {
  switch (policy.rule) {
    case "unanimous":
      return "Unanimous";
    case "majority":
      return "Majority rule";
    case "owner_only":
      return "Owner decides";
    case "threshold":
      return `${policy.thresholdN ?? "?"} approvals suffice`;
  }
}

export function PolicyBadge({ policy }: { policy: ConsensusPolicy }) {
  if (policy.rule === "unanimous") {
    return (
      <Badge variant="outline" title="Every active member must approve agent actions.">
        Unanimous
      </Badge>
    );
  }
  return (
    <Badge
      variant="warning"
      title="This board has relaxed the default unanimous rule. Changing it back is itself a proposal."
    >
      <AlertTriangle aria-hidden />
      {policyLabel(policy)}
    </Badge>
  );
}
