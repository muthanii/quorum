/**
 * Contract tests for the webhook turn pipeline against a local mock agent
 * server (§10: timeout, malformed response, duplicate turnId, oversized
 * payload, SSRF attempts). The mock lives on http://127.0.0.1; the agent row
 * points at https://agent.test, a fake resolver answers with a public IP for
 * the SSRF guard, and an injected fetch rewrites the origin onto the mock.
 */
import { afterEach, describe, expect, it } from "vitest";

import { verifySignature } from "@quorum/agent-protocol/v1/signature";
import { turnPayloadSchema } from "@quorum/shared/schemas/turn";

import { TurnError } from "../src/errors";
import { markAgentDegraded } from "../src/degraded";
import { processTurn, ALL_CAPABILITIES, type TurnDeps } from "../src/turn";
import {
  captureLogger,
  fakeAgentStore,
  fakeIdempotency,
  INTERNAL_SECRET,
  jsonHandler,
  makeAgentRow,
  makeTurnJob,
  neverFetch,
  publicResolver,
  requestAt,
  rewriteFetch,
  SIGNING_SECRET,
  startMockServer,
  type MockServer,
} from "./helpers";

const openServers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function mock(handler: Parameters<typeof startMockServer>[0]): Promise<MockServer> {
  const server = await startMockServer(handler);
  openServers.push(server);
  return server;
}

const VALID_RESPONSE = {
  messages: [{ content: "Here's a first pass." }],
  operations: [{ op: "artifact.create", type: "doc", title: "Q3 Brief", content: "..." }],
};

interface Setup {
  deps: TurnDeps;
  agentServer: MockServer;
  wsServer: MockServer;
  lines: Array<Record<string, unknown>>;
}

async function setup(
  agentHandler: Parameters<typeof startMockServer>[0],
  overrides: Partial<TurnDeps> = {},
): Promise<Setup> {
  const agentServer = await mock(agentHandler);
  const wsServer = await mock(jsonHandler(200, { ok: true }));
  const { logger, lines } = captureLogger();
  const deps: TurnDeps = {
    idempotency: fakeIdempotency(),
    store: fakeAgentStore([]),
    wsBaseUrl: wsServer.origin,
    internalApiSecret: INTERNAL_SECRET,
    log: logger,
    fetchFn: rewriteFetch({ "https://agent.test": agentServer.origin }),
    resolve: publicResolver(),
    ...overrides,
  };
  return { deps, agentServer, wsServer, lines };
}

async function rejection(promise: Promise<unknown>): Promise<TurnError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TurnError);
  return err as TurnError;
}

describe("processTurn — webhook happy path", () => {
  it("signs the request, forwards the bearer, and posts the validated result to ws", async () => {
    const agent = makeAgentRow();
    const job = makeTurnJob(agent);
    const { deps, agentServer, wsServer } = await setup(jsonHandler(200, VALID_RESPONSE), {
      store: fakeAgentStore([agent]),
    });

    const outcome = await processTurn(job, "job-1", deps);
    expect(outcome).toMatchObject({
      status: "completed",
      turnId: job.turnId,
      boardId: job.boardId,
      agentId: job.agentId,
      messageCount: 1,
      operationCount: 1,
    });

    // The agent saw exactly one signed, authorized, schema-valid TurnPayload.
    expect(agentServer.requests).toHaveLength(1);
    const req = requestAt(agentServer, 0);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/hook");
    expect(req.headers.authorization).toBe("Bearer agent-bearer-token");
    const header = req.headers["x-quorum-signature"];
    expect(typeof header).toBe("string");
    // Verified with the SHARED helper — the same code agent authors vendor.
    expect(
      verifySignature({
        secret: SIGNING_SECRET,
        rawBody: req.body,
        header: header as string,
        nowSec: Math.floor(Date.now() / 1000),
      }),
    ).toBe(true);
    // Tampered bodies must not verify.
    expect(
      verifySignature({
        secret: SIGNING_SECRET,
        rawBody: `${req.body} `,
        header: header as string,
        nowSec: Math.floor(Date.now() / 1000),
      }),
    ).toBe(false);

    const payload = turnPayloadSchema.parse(JSON.parse(req.body));
    expect(payload.turnId).toBe(job.turnId);
    expect(payload.agent).toEqual({ id: agent.id, name: agent.name });
    expect(payload.capabilities).toEqual(ALL_CAPABILITIES);
    expect(payload.context.messages[0]?.content).toBe("@Researcher go");

    // The validated result reached the ws internal API with the bearer.
    expect(wsServer.requests).toHaveLength(1);
    const wsReq = requestAt(wsServer, 0);
    expect(wsReq.url).toBe("/internal/agent-result");
    expect(wsReq.headers.authorization).toBe(`Bearer ${INTERNAL_SECRET}`);
    expect(JSON.parse(wsReq.body)).toEqual({
      boardId: job.boardId,
      agentId: job.agentId,
      turnId: job.turnId,
      messages: VALID_RESPONSE.messages,
      operations: VALID_RESPONSE.operations,
    });
  });

  it("omits the Authorization header when no credential is stored", async () => {
    const agent = makeAgentRow({ credential: null });
    const job = makeTurnJob(agent);
    const { deps, agentServer } = await setup(jsonHandler(200, { messages: [] }), {
      store: fakeAgentStore([agent]),
    });
    await processTurn(job, "job-1", deps);
    expect(agentServer.requests[0]?.headers.authorization).toBeUndefined();
  });
});

describe("processTurn — failure contract", () => {
  it("maps a hung agent to a retryable timeout error", async () => {
    const agent = makeAgentRow();
    const { deps } = await setup(() => {
      /* never respond */
    });
    Object.assign(deps, { store: fakeAgentStore([agent]), timeoutMs: 150 });

    const err = await rejection(processTurn(makeTurnJob(agent), "job-1", deps));
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  it("rejects a non-JSON response as non-retryable, and the degraded path follows", async () => {
    const agent = makeAgentRow();
    const job = makeTurnJob(agent);
    const store = fakeAgentStore([agent]);
    const { deps, wsServer, lines } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("this is not json {");
    });
    Object.assign(deps, { store });

    const err = await rejection(processTurn(job, "job-1", deps));
    expect(err.code).toBe("malformed_response");
    expect(err.retryable).toBe(false);
    // Nothing invalid may reach the board: no result post happened.
    expect(wsServer.requests).toHaveLength(0);

    // What main.ts does after the final attempt:
    await markAgentDegraded(
      { boardId: job.boardId, agentId: job.agentId },
      {
        store,
        wsBaseUrl: wsServer.origin,
        internalApiSecret: INTERNAL_SECRET,
        log: deps.log,
      },
    );
    expect(store.statusUpdates).toEqual([{ agentId: agent.id, status: "degraded" }]);
    expect(wsServer.requests).toHaveLength(1);
    expect(requestAt(wsServer, 0).url).toBe("/internal/agent-status");
    expect(JSON.parse(requestAt(wsServer, 0).body)).toEqual({
      boardId: job.boardId,
      agentId: agent.id,
      status: "degraded",
    });
    expect(lines.some((line) => line.level === "error" || line.level === "warn")).toBe(false);
  });

  it("rejects a schema-invalid AgentResponse as non-retryable", async () => {
    const agent = makeAgentRow();
    const { deps, wsServer } = await setup(
      jsonHandler(200, { operations: [{ op: "artifact.create" }] }),
      {},
    );
    Object.assign(deps, { store: fakeAgentStore([agent]) });

    const err = await rejection(processTurn(makeTurnJob(agent), "job-1", deps));
    expect(err.code).toBe("invalid_response");
    expect(err.retryable).toBe(false);
    expect(wsServer.requests).toHaveLength(0);
  });

  it("treats agent 5xx as retryable and 4xx as final", async () => {
    const agent = makeAgentRow();
    const flaky = await setup(jsonHandler(503, {}));
    Object.assign(flaky.deps, { store: fakeAgentStore([agent]) });
    const transient = await rejection(processTurn(makeTurnJob(agent), "job-1", flaky.deps));
    expect(transient.code).toBe("agent_http_error");
    expect(transient.retryable).toBe(true);

    const broken = await setup(jsonHandler(404, {}));
    Object.assign(broken.deps, { store: fakeAgentStore([agent]) });
    const final = await rejection(processTurn(makeTurnJob(agent), "job-1", broken.deps));
    expect(final.retryable).toBe(false);
  });

  it("rejects an oversized response mid-stream without buffering it", async () => {
    const agent = makeAgentRow();
    const chunk = Buffer.alloc(64 * 1024, 97);
    const { deps } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const write = (): void => {
        if (res.destroyed || res.writableEnded) return;
        res.write(chunk);
        setTimeout(write, 2);
      };
      write();
    });
    Object.assign(deps, { store: fakeAgentStore([agent]), maxResponseBytes: 100 * 1024 });

    const err = await rejection(processTurn(makeTurnJob(agent), "job-1", deps));
    expect(err.code).toBe("oversized_response");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("mid-stream");
  });

  it("retries when the ws result post fails", async () => {
    const agent = makeAgentRow();
    const agentServer = await mock(jsonHandler(200, VALID_RESPONSE));
    const wsServer = await mock(jsonHandler(500, {}));
    const { logger } = captureLogger();
    const deps: TurnDeps = {
      idempotency: fakeIdempotency(),
      store: fakeAgentStore([agent]),
      wsBaseUrl: wsServer.origin,
      internalApiSecret: INTERNAL_SECRET,
      log: logger,
      fetchFn: rewriteFetch({ "https://agent.test": agentServer.origin }),
      resolve: publicResolver(),
    };
    const err = await rejection(processTurn(makeTurnJob(agent), "job-1", deps));
    expect(err.code).toBe("result_post_failed");
    expect(err.retryable).toBe(true);
  });
});

describe("processTurn — idempotency on turnId", () => {
  it("drops a duplicate enqueue of the same turnId with a structured log", async () => {
    const agent = makeAgentRow();
    const job = makeTurnJob(agent);
    const idempotency = fakeIdempotency();
    const { deps, agentServer, wsServer, lines } = await setup(jsonHandler(200, VALID_RESPONSE), {
      store: fakeAgentStore([agent]),
      idempotency,
    });

    const first = await processTurn(job, "job-1", deps);
    expect(first.status).toBe("completed");

    // Same turnId, different job → duplicate, dropped before any outbound call.
    const second = await processTurn(job, "job-2", deps);
    expect(second).toEqual({ status: "duplicate", turnId: job.turnId });
    expect(agentServer.requests).toHaveLength(1);
    expect(wsServer.requests).toHaveLength(1);
    const dropLine = lines.find((line) => line.message === "duplicate turn dropped");
    expect(dropLine).toMatchObject({ level: "warn", turnId: job.turnId });
  });

  it("lets a BullMQ retry (same job token) through the claim", async () => {
    const agent = makeAgentRow();
    const job = makeTurnJob(agent);
    const { deps, agentServer } = await setup(jsonHandler(200, VALID_RESPONSE), {
      store: fakeAgentStore([agent]),
    });

    await processTurn(job, "job-1", deps);
    const retried = await processTurn(job, "job-1", deps);
    expect(retried.status).toBe("completed");
    expect(agentServer.requests).toHaveLength(2);
  });
});

describe("processTurn — SSRF attempts", () => {
  async function ssrfCase(endpointUrl: string, resolve = publicResolver()): Promise<TurnError> {
    const agent = makeAgentRow({ endpointUrl });
    const { logger } = captureLogger();
    const deps: TurnDeps = {
      idempotency: fakeIdempotency(),
      store: fakeAgentStore([agent]),
      wsBaseUrl: "http://127.0.0.1:9",
      internalApiSecret: INTERNAL_SECRET,
      log: logger,
      fetchFn: neverFetch,
      resolve,
    };
    return rejection(processTurn(makeTurnJob(agent), "job-1", deps));
  }

  it("rejects a private IP literal endpoint before any fetch", async () => {
    const err = await ssrfCase("https://127.0.0.1/hook");
    expect(err.code).toBe("ssrf_rejected");
    expect(err.retryable).toBe(false);
  });

  it("rejects the cloud metadata endpoint", async () => {
    const err = await ssrfCase("https://169.254.169.254/latest/meta-data/");
    expect(err.code).toBe("ssrf_rejected");
  });

  it("rejects plain http endpoints", async () => {
    const err = await ssrfCase("http://agent.test/hook");
    expect(err.code).toBe("ssrf_rejected");
    expect(err.retryable).toBe(false);
  });

  it("rejects hostnames that resolve to a private address", async () => {
    const err = await ssrfCase("https://internal.test/hook", async () => [
      { address: "10.0.0.5", family: 4 },
    ]);
    expect(err.code).toBe("ssrf_rejected");
  });
});

describe("processTurn — job and agent validation", () => {
  it("rejects malformed job data as non-retryable", async () => {
    const { logger } = captureLogger();
    const deps: TurnDeps = {
      idempotency: fakeIdempotency(),
      store: fakeAgentStore([]),
      wsBaseUrl: "http://127.0.0.1:9",
      internalApiSecret: INTERNAL_SECRET,
      log: logger,
      fetchFn: neverFetch,
    };
    const err = await rejection(processTurn({ nonsense: true }, "job-1", deps));
    expect(err.code).toBe("invalid_job");
    expect(err.retryable).toBe(false);
  });

  it("rejects an unknown agent and a board mismatch", async () => {
    const agent = makeAgentRow();
    const other = makeAgentRow();
    const job = { ...makeTurnJob(agent), boardId: other.boardId };
    const { deps } = await setup(jsonHandler(200, VALID_RESPONSE), {
      store: fakeAgentStore([agent]),
    });

    const missing = await rejection(processTurn(makeTurnJob(other), "job-1", deps));
    expect(missing.code).toBe("agent_not_found");

    const mismatch = await rejection(processTurn(job, "job-2", deps));
    expect(mismatch.code).toBe("agent_board_mismatch");
  });

  it("fails a webhook agent with no signing secret as non-retryable", async () => {
    const agent = makeAgentRow({ signingSecret: null });
    const { deps, agentServer } = await setup(jsonHandler(200, VALID_RESPONSE), {
      store: fakeAgentStore([agent]),
    });
    const err = await rejection(processTurn(makeTurnJob(agent), "job-1", deps));
    expect(err.code).toBe("agent_not_configured");
    expect(err.retryable).toBe(false);
    expect(agentServer.requests).toHaveLength(0);
  });
});
