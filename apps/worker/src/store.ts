/**
 * Postgres access behind a small injectable interface so contract tests run
 * without a live database.
 */
import { eq } from "drizzle-orm";

import { getDb } from "@quorum/db/client";
import { agents, type AgentRow } from "@quorum/db/schema";
import { isId } from "@quorum/shared/ids";
import { AGENT_STATUSES, type AgentStatus } from "@quorum/shared/schemas/agent";

export interface AgentStore {
  getAgent(agentId: string): Promise<AgentRow | null>;
  setAgentStatus(agentId: string, status: AgentStatus): Promise<void>;
}

export function createPgAgentStore(): AgentStore {
  return {
    async getAgent(agentId) {
      const row = await getDb().query.agents.findFirst({
        where: (table, { eq }) => eq(table.id, agentId),
      });
      return row ?? null;
    },

    async setAgentStatus(agentId, status) {
      if (!isId("agent", agentId)) throw new Error("setAgentStatus: invalid agent id");
      if (!AGENT_STATUSES.includes(status)) throw new Error("setAgentStatus: invalid status");
      await getDb().update(agents).set({ status }).where(eq(agents.id, agentId));
    },
  };
}
