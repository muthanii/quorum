import { afterEach, describe, expect, it } from "vitest";

import { markAgentDegraded, markAgentReady, type AgentHealthDeps } from "../src/degraded";
import {
  captureLogger,
  fakeAgentStore,
  INTERNAL_SECRET,
  jsonHandler,
  makeAgentRow,
  requestAt,
  startMockServer,
  type MockServer,
} from "./helpers";

const openServers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function setup(wsHandler = jsonHandler(200, { ok: true })): Promise<{
  deps: AgentHealthDeps;
  store: ReturnType<typeof fakeAgentStore>;
  wsServer: MockServer;
  lines: Array<Record<string, unknown>>;
}> {
  const wsServer = await startMockServer(wsHandler);
  openServers.push(wsServer);
  const store = fakeAgentStore([]);
  const { logger, lines } = captureLogger();
  return {
    deps: {
      store,
      wsBaseUrl: wsServer.origin,
      internalApiSecret: INTERNAL_SECRET,
      log: logger,
    },
    store,
    wsServer,
    lines,
  };
}

describe("agent health transitions", () => {
  it("marks degraded in pg and mirrors to the ws internal API", async () => {
    const agent = makeAgentRow();
    const { deps, store, wsServer } = await setup();

    await markAgentDegraded({ boardId: agent.boardId, agentId: agent.id }, deps);

    expect(store.statusUpdates).toEqual([{ agentId: agent.id, status: "degraded" }]);
    const req = requestAt(wsServer, 0);
    expect(req.url).toBe("/internal/agent-status");
    expect(req.headers.authorization).toBe(`Bearer ${INTERNAL_SECRET}`);
    expect(JSON.parse(req.body)).toEqual({
      boardId: agent.boardId,
      agentId: agent.id,
      status: "degraded",
    });
  });

  it("resets to ready after a successful turn", async () => {
    const agent = makeAgentRow();
    const { deps, store, wsServer } = await setup();

    await markAgentReady({ boardId: agent.boardId, agentId: agent.id }, deps);

    expect(store.statusUpdates).toEqual([{ agentId: agent.id, status: "ready" }]);
    expect(JSON.parse(requestAt(wsServer, 0).body)).toMatchObject({ status: "ready" });
  });

  it("still mirrors to ws when the pg write fails, and logs instead of throwing", async () => {
    const agent = makeAgentRow();
    const { deps, wsServer, lines } = await setup();
    deps.store = {
      setAgentStatus: async () => {
        throw new Error("pg is down");
      },
    };

    await expect(
      markAgentDegraded({ boardId: agent.boardId, agentId: agent.id }, deps),
    ).resolves.toBeUndefined();

    expect(wsServer.requests).toHaveLength(1);
    const errorLine = lines.find(
      (line) => line.message === "failed to persist agent status to postgres",
    );
    expect(errorLine).toMatchObject({ level: "error", agentId: agent.id });
  });

  it("logs a rejected ws mirror instead of throwing", async () => {
    const agent = makeAgentRow();
    const { deps, lines } = await setup(jsonHandler(500, {}));

    await expect(
      markAgentReady({ boardId: agent.boardId, agentId: agent.id }, deps),
    ).resolves.toBeUndefined();

    const errorLine = lines.find(
      (line) => line.message === "ws agent-status endpoint rejected the update",
    );
    expect(errorLine).toMatchObject({ level: "error", httpStatus: 500 });
  });
});
