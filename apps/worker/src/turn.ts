/**
 * The agent-turn processor (CLAUDE.md §5). The worker calls user-supplied
 * endpoints and NEVER executes user code. All I/O is injected so the contract
 * tests run against a local mock server with no live Postgres or Redis.
 *
 * Flow: validate job → claim turnId (idempotency) → load agent row → decrypt
 * secrets → SSRF-check the endpoint → call it (signed webhook or model loop)
 * → validate the AgentResponse → hand it to the ws server, which stages every
 * operation as a Proposal. Nothing here mutates a board directly.
 */
import { z } from "zod";

import { SIGNATURE_HEADER, signRequest } from "@quorum/agent-protocol/v1/signature";
import {
  type AgentCapability,
  type AgentResponse,
  type TurnPayload,
} from "@quorum/agent-protocol/v1/types";
import { decryptSecret } from "@quorum/db/crypto";
import { type AgentRow } from "@quorum/db/schema";
import { idSchema } from "@quorum/shared/ids";
import {
  agentResponseSchema,
  MAX_AGENT_RESPONSE_BYTES,
  triggerTypeSchema,
  turnContextSchema,
} from "@quorum/shared/schemas/turn";

import { isRetryableHttpStatus, TurnError, zodIssueSummary } from "./errors";
import { httpCall } from "./http";
import { type Logger } from "./log";
import { runModelTurn } from "./model";
import { assertPublicHttpsUrl, SsrfError, type Resolver } from "./ssrf";
import { type AgentStore } from "./store";

/** v1 grants every capability; per-agent capability profiles come later. */
export const ALL_CAPABILITIES: AgentCapability[] = [
  "message",
  "artifact.create",
  "artifact.patch",
  "proposal.create",
];

export const IDEMPOTENCY_KEY_PREFIX = "quorum:turn:";
export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;
/** Per-request deadline (CLAUDE.md §5: timeout 60s, 3 retries). */
export const TURN_TIMEOUT_MS = 60_000;
const RESULT_POST_TIMEOUT_MS = 10_000;
const INTERNAL_RESPONSE_CAP_BYTES = 64 * 1024;

/** Job payload enqueued by the ws server on the "agent-turns" queue. */
export const turnJobSchema = z.object({
  turnId: idSchema("turn"),
  boardId: idSchema("board"),
  agentId: idSchema("agent"),
  trigger: z.object({ type: triggerTypeSchema }),
  context: turnContextSchema,
});

export type TurnJobData = z.infer<typeof turnJobSchema>;

/**
 * The slice of Redis the processor needs — matches the ioredis `SET key value
 * EX ttl NX` overload so the real client satisfies it structurally and tests
 * can substitute a Map.
 */
export interface IdempotencyStore {
  set(
    key: string,
    value: string,
    secondsToken: "EX",
    seconds: number,
    nx: "NX",
  ): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
}

export interface TurnDeps {
  idempotency: IdempotencyStore;
  store: AgentStore;
  wsBaseUrl: string;
  internalApiSecret: string;
  log: Logger;
  fetchFn?: typeof fetch;
  /** Injectable DNS resolver, forwarded to the SSRF guard (tests only). */
  resolve?: Resolver;
  timeoutMs?: number;
  maxResponseBytes?: number;
  nowMs?: () => number;
}

export type TurnOutcome =
  | { status: "duplicate"; turnId: string }
  | {
      status: "completed";
      turnId: string;
      boardId: string;
      agentId: string;
      messageCount: number;
      operationCount: number;
    };

export async function processTurn(
  data: unknown,
  jobToken: string,
  deps: TurnDeps,
): Promise<TurnOutcome> {
  const parsedJob = turnJobSchema.safeParse(data);
  if (!parsedJob.success) {
    throw new TurnError("invalid_job", `turn job rejected: ${zodIssueSummary(parsedJob.error)}`, {
      retryable: false,
    });
  }
  const job = parsedJob.data;
  const log = deps.log.with({ turnId: job.turnId, boardId: job.boardId, agentId: job.agentId });

  // Idempotency: first claim wins for 24h. A BullMQ retry re-runs with the
  // same jobToken and passes; a duplicate enqueue carries a different token
  // and is dropped. The agent side is additionally protected by the contract
  // ("idempotent on turnId") for the crash-between-claim-and-call window.
  const key = `${IDEMPOTENCY_KEY_PREFIX}${job.turnId}`;
  const claimed = await deps.idempotency.set(key, jobToken, "EX", IDEMPOTENCY_TTL_SEC, "NX");
  if (claimed !== "OK") {
    const holder = await deps.idempotency.get(key);
    if (holder !== jobToken) {
      log.warn("duplicate turn dropped", { holderToken: holder, jobToken });
      return { status: "duplicate", turnId: job.turnId };
    }
  }

  const agent = await deps.store.getAgent(job.agentId);
  if (agent === null) {
    throw new TurnError("agent_not_found", `agent ${job.agentId} does not exist`, {
      retryable: false,
    });
  }
  if (agent.boardId !== job.boardId) {
    throw new TurnError(
      "agent_board_mismatch",
      `agent ${job.agentId} does not belong to board ${job.boardId}`,
      { retryable: false },
    );
  }

  const payload: TurnPayload = {
    turnId: job.turnId,
    boardId: job.boardId,
    agent: { id: agent.id, name: agent.name },
    trigger: job.trigger,
    context: job.context,
    capabilities: ALL_CAPABILITIES,
  };

  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TURN_TIMEOUT_MS;
  const maxResponseBytes = deps.maxResponseBytes ?? MAX_AGENT_RESPONSE_BYTES;
  log.info("turn started", { kind: agent.kind, endpointHost: safeHost(agent.endpointUrl) });

  // SSRF enforcement happens here, at call time, for both kinds — the web
  // layer only does a shallow sanity check at connect time.
  try {
    await assertPublicHttpsUrl(agent.endpointUrl, { resolve: deps.resolve });
  } catch (err) {
    if (err instanceof SsrfError) {
      log.warn("agent endpoint rejected by SSRF guard", {
        ssrfCode: err.code,
        endpointHost: safeHost(agent.endpointUrl),
      });
      throw new TurnError("ssrf_rejected", err.message, { retryable: false, cause: err });
    }
    throw err;
  }

  const response =
    agent.kind === "webhook"
      ? await runWebhookTurn(agent, payload, {
          fetchFn,
          timeoutMs,
          maxResponseBytes,
          nowMs: deps.nowMs ?? Date.now,
        })
      : await runModelTurn({
          payload,
          endpointUrl: agent.endpointUrl,
          model: agent.model,
          apiKey: decryptStoredSecret(agent, "credential"),
          fetchFn,
          timeoutMs,
          maxResponseBytes,
        });

  await postAgentResult(job, response, { fetchFn, deps });

  const outcome: TurnOutcome = {
    status: "completed",
    turnId: job.turnId,
    boardId: job.boardId,
    agentId: job.agentId,
    messageCount: response.messages?.length ?? 0,
    operationCount: response.operations?.length ?? 0,
  };
  log.info("turn completed", {
    messageCount: outcome.messageCount,
    operationCount: outcome.operationCount,
  });
  return outcome;
}

interface WebhookCallOpts {
  fetchFn: typeof fetch;
  timeoutMs: number;
  maxResponseBytes: number;
  nowMs: () => number;
}

async function runWebhookTurn(
  agent: AgentRow,
  payload: TurnPayload,
  opts: WebhookCallOpts,
): Promise<AgentResponse> {
  const signingSecret = decryptStoredSecret(agent, "signing");
  if (signingSecret === null) {
    throw new TurnError("agent_not_configured", "webhook agent has no signing secret stored", {
      retryable: false,
    });
  }
  const credential = decryptStoredSecret(agent, "credential");

  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [SIGNATURE_HEADER]: signRequest(signingSecret, rawBody, Math.floor(opts.nowMs() / 1000)),
  };
  if (credential !== null) headers.authorization = `Bearer ${credential}`;

  const result = await httpCall({
    fetchFn: opts.fetchFn,
    url: agent.endpointUrl,
    init: { method: "POST", headers, body: rawBody },
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes,
  });
  if (!result.ok) {
    throw new TurnError("agent_http_error", `agent endpoint answered ${result.status}`, {
      retryable: isRetryableHttpStatus(result.status),
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(result.bodyText) as unknown;
  } catch (cause) {
    throw new TurnError("malformed_response", "agent response was not valid JSON", {
      retryable: false,
      cause,
    });
  }
  const parsed = agentResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new TurnError(
      "invalid_response",
      `agent response failed validation: ${zodIssueSummary(parsed.error)}`,
      { retryable: false },
    );
  }
  return parsed.data;
}

async function postAgentResult(
  job: TurnJobData,
  response: AgentResponse,
  ctx: { fetchFn: typeof fetch; deps: TurnDeps },
): Promise<void> {
  const result = await httpCall({
    fetchFn: ctx.fetchFn,
    url: `${ctx.deps.wsBaseUrl}/internal/agent-result`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ctx.deps.internalApiSecret}`,
      },
      body: JSON.stringify({
        boardId: job.boardId,
        agentId: job.agentId,
        turnId: job.turnId,
        messages: response.messages ?? [],
        operations: response.operations ?? [],
      }),
    },
    timeoutMs: RESULT_POST_TIMEOUT_MS,
    maxResponseBytes: INTERNAL_RESPONSE_CAP_BYTES,
  });
  if (!result.ok) {
    throw new TurnError("result_post_failed", `ws internal API answered ${result.status}`, {
      retryable: true,
    });
  }
}

/**
 * Decrypt one of the agent row's AES-GCM secrets. Returns null when the
 * columns are empty. The plaintext must never reach a log line or an error
 * message — it goes straight into a request header and nowhere else.
 */
function decryptStoredSecret(agent: AgentRow, which: "credential" | "signing"): string | null {
  const [ciphertext, iv, tag] =
    which === "credential"
      ? [agent.encryptedCredential, agent.credentialIv, agent.credentialTag]
      : [agent.encryptedSigningSecret, agent.signingSecretIv, agent.signingSecretTag];
  if (ciphertext === null || iv === null || tag === null) return null;
  try {
    return decryptSecret({ ciphertext, iv, tag });
  } catch (cause) {
    // GCM auth failure or wrong key — the cause carries no secret material.
    throw new TurnError("agent_not_configured", `stored agent ${which} secret failed to decrypt`, {
      retryable: false,
      cause,
    });
  }
}

/** Hostname only — full endpoint URLs may embed tokens and must not be logged. */
function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "(unparseable)";
  }
}
