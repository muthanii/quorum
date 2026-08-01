"use client";

/**
 * Collapsible agent strip under the board header: glyph, name, live status
 * pill (doc's agentStatus map, REST status as fallback), and an "awaiting
 * approval" marker while the add_agent proposal is still open (adding an
 * agent is consensus-gated — brief addendum #6).
 */
import { Bot, Plus } from "lucide-react";

import type { AgentStatusEntry } from "@quorum/shared/schemas/agent";

import { StatusPill } from "@/components/agents/StatusPill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BoardAgentDto } from "@/lib/api/types";

export interface AgentRosterProps {
  agents: BoardAgentDto[];
  /** Live statuses from the doc's agentStatus map (agentId → entry). */
  statuses: Record<string, AgentStatusEntry>;
  /** Agents whose add_agent proposal is still open. */
  pendingAgentIds: ReadonlySet<string>;
  canConnect: boolean;
  onConnectAgent: () => void;
}

export function AgentRoster({
  agents,
  statuses,
  pendingAgentIds,
  canConnect,
  onConnectAgent,
}: AgentRosterProps) {
  return (
    <div
      id="agent-roster"
      role="region"
      aria-label="Agent roster"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-surface px-4 py-2"
    >
      {agents.length === 0 ? (
        <span className="text-xs text-muted">
          No agents yet — connect one and it works alongside everyone, with every action put to a
          vote.
        </span>
      ) : (
        agents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center gap-2 rounded-control border bg-background px-2 py-1"
          >
            <Bot aria-hidden className="size-4 text-muted" />
            <span className="max-w-32 truncate text-ui font-medium">{agent.name}</span>
            <span className="text-[10px] text-faint uppercase">{agent.kind}</span>
            <StatusPill status={statuses[agent.id]?.status ?? agent.status} />
            {pendingAgentIds.has(agent.id) ? (
              <Badge variant="warning" title="This agent participates only once everyone approves.">
                Awaiting approval
              </Badge>
            ) : null}
          </div>
        ))
      )}
      {canConnect ? (
        <Button variant="secondary" size="sm" onClick={onConnectAgent}>
          <Plus aria-hidden />
          Connect agent
        </Button>
      ) : null}
    </div>
  );
}
