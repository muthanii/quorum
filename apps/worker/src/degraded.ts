/**
 * Agent health transitions: after the final failed attempt an agent is marked
 * "degraded" (visible pill in the roster, CLAUDE.md §5); a successful turn
 * resets it to "ready". Postgres is the record; the ws internal API mirrors
 * the status into the Y.Doc so every board sees the pill flip live.
 *
 * These never throw — they run inside BullMQ event handlers where an
 * exception has nowhere to go. Every failure is surfaced as a structured log.
 */
import { errorFields, type Logger } from "./log";
import { httpCall } from "./http";
import { type AgentStore } from "./store";

export interface AgentHealthDeps {
  store: Pick<AgentStore, "setAgentStatus">;
  wsBaseUrl: string;
  internalApiSecret: string;
  log: Logger;
  fetchFn?: typeof fetch;
}

export interface AgentHealthTarget {
  boardId: string;
  agentId: string;
}

const STATUS_POST_TIMEOUT_MS = 10_000;
const STATUS_RESPONSE_CAP_BYTES = 64 * 1024;

async function setAgentHealth(
  target: AgentHealthTarget,
  status: "ready" | "degraded",
  deps: AgentHealthDeps,
): Promise<void> {
  const log = deps.log.with({ boardId: target.boardId, agentId: target.agentId, status });

  try {
    await deps.store.setAgentStatus(target.agentId, status);
  } catch (err) {
    log.error("failed to persist agent status to postgres", errorFields(err));
  }

  // Mirror to ws even when the pg write failed — the roster pill updating
  // live matters more than perfect ordering; pg converges on the next change.
  try {
    const result = await httpCall({
      fetchFn: deps.fetchFn ?? fetch,
      url: `${deps.wsBaseUrl}/internal/agent-status`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.internalApiSecret}`,
        },
        body: JSON.stringify({ boardId: target.boardId, agentId: target.agentId, status }),
      },
      timeoutMs: STATUS_POST_TIMEOUT_MS,
      maxResponseBytes: STATUS_RESPONSE_CAP_BYTES,
    });
    if (!result.ok) {
      log.error("ws agent-status endpoint rejected the update", { httpStatus: result.status });
    }
  } catch (err) {
    log.error("failed to mirror agent status to ws", errorFields(err));
  }
}

/** Final-attempt failure: the agent is visibly degraded until its next good turn. */
export function markAgentDegraded(target: AgentHealthTarget, deps: AgentHealthDeps): Promise<void> {
  return setAgentHealth(target, "degraded", deps);
}

/** Successful turn: clear any degraded pill. */
export function markAgentReady(target: AgentHealthTarget, deps: AgentHealthDeps): Promise<void> {
  return setAgentHealth(target, "ready", deps);
}
