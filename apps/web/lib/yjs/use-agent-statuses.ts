"use client";

/**
 * Live agent roster statuses from the Y.Doc "agentStatus" map (written only
 * by the ws server). Drives the ready/running/degraded pills; the REST
 * agent.status is the fallback for agents the ws has not touched yet.
 */
import { useMemo } from "react";
import type * as Y from "yjs";

import type { AgentStatusEntry } from "@quorum/shared/schemas/agent";
import { getAgentStatusMap, readAgentStatuses } from "@quorum/shared/yjs/doc";

import { useYSnapshot } from "./use-y-snapshot";

const EMPTY_STATUSES: Record<string, AgentStatusEntry> = {};

export function useAgentStatuses(doc: Y.Doc | null): Record<string, AgentStatusEntry> {
  const map = useMemo(() => (doc ? getAgentStatusMap(doc) : null), [doc]);

  return useYSnapshot(map, () => (doc ? readAgentStatuses(doc) : EMPTY_STATUSES), EMPTY_STATUSES);
}
