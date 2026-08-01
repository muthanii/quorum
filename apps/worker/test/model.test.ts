/**
 * Contract tests for direct model agents: OpenAI-compatible by default,
 * Anthropic-compatible when the base URL mentions "anthropic", fenced-JSON
 * tolerance, and the model-name-in-fragment convention.
 */
import { afterEach, describe, expect, it } from "vitest";

import { TurnError } from "../src/errors";
import { parseModelEndpoint, parseModelReply } from "../src/model";
import { processTurn, type TurnDeps } from "../src/turn";
import {
  captureLogger,
  fakeAgentStore,
  fakeIdempotency,
  INTERNAL_SECRET,
  jsonHandler,
  makeAgentRow,
  makeTurnJob,
  publicResolver,
  requestAt,
  rewriteFetch,
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

async function runModelAgent(
  endpointUrl: string,
  publicOrigin: string,
  handler: Parameters<typeof startMockServer>[0],
  model: string | null = "gpt-4o-mini",
): Promise<{
  modelServer: MockServer;
  wsServer: MockServer;
  outcome: Awaited<ReturnType<typeof processTurn>>;
}> {
  const agent = makeAgentRow({ kind: "model", endpointUrl, model, credential: "sk-test-12345" });
  const modelServer = await mock(handler);
  const wsServer = await mock(jsonHandler(200, { ok: true }));
  const { logger } = captureLogger();
  const deps: TurnDeps = {
    idempotency: fakeIdempotency(),
    store: fakeAgentStore([agent]),
    wsBaseUrl: wsServer.origin,
    internalApiSecret: INTERNAL_SECRET,
    log: logger,
    fetchFn: rewriteFetch({ [publicOrigin]: modelServer.origin }),
    resolve: publicResolver(),
  };
  const outcome = await processTurn(makeTurnJob(agent), "job-1", deps);
  return { modelServer, wsServer, outcome };
}

describe("model agents — OpenAI-compatible", () => {
  it("calls chat/completions, tolerates fenced JSON, and posts the parsed result", async () => {
    const reply = {
      choices: [
        {
          message: {
            content: '```json\n{"messages":[{"content":"done"}],"operations":[]}\n```',
          },
        },
      ],
    };
    const { modelServer, wsServer } = await runModelAgent(
      "https://models.test/v1",
      "https://models.test",
      jsonHandler(200, reply),
    );

    const req = requestAt(modelServer, 0);
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-test-12345");
    const body = JSON.parse(req.body) as { model: string; messages: Array<{ role: string }> };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);

    expect(JSON.parse(requestAt(wsServer, 0).body)).toMatchObject({
      messages: [{ content: "done" }],
      operations: [],
    });
  });

  it("rejects a completion that is not Agent Protocol JSON", async () => {
    const reply = { choices: [{ message: { content: "sure, here is prose, no JSON" } }] };
    const err = await runModelAgent(
      "https://models.test/v1",
      "https://models.test",
      jsonHandler(200, reply),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TurnError);
    expect((err as TurnError).code).toBe("malformed_response");
    expect((err as TurnError).retryable).toBe(false);
  });
});

describe("model agents — Anthropic-compatible", () => {
  it("detects anthropic in the base URL and uses the /v1/messages shape", async () => {
    const reply = {
      content: [{ type: "text", text: '{"messages":[{"content":"ack"}],"operations":[]}' }],
    };
    const { modelServer, wsServer } = await runModelAgent(
      "https://gateway.anthropic.test",
      "https://gateway.anthropic.test",
      jsonHandler(200, reply),
      "claude-sonnet-4-5",
    );

    const req = requestAt(modelServer, 0);
    expect(req.url).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-test-12345");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers.authorization).toBeUndefined();
    const body = JSON.parse(req.body) as { model: string; system: string; max_tokens: number };
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.system).toContain("Researcher");

    expect(JSON.parse(requestAt(wsServer, 0).body)).toMatchObject({
      messages: [{ content: "ack" }],
    });
  });

  it("does not double the /v1 prefix when the base URL already has it", () => {
    expect(parseModelEndpoint("https://api.anthropic.com/v1", "claude-x").baseUrl).toBe(
      "https://api.anthropic.com/v1",
    );
  });
});

describe("model endpoint configuration", () => {
  it("fails without a stored model name instead of guessing a default", async () => {
    const err = await runModelAgent(
      "https://models.test/v1",
      "https://models.test",
      jsonHandler(200, {}),
      null,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TurnError);
    expect((err as TurnError).code).toBe("agent_not_configured");
    expect((err as TurnError).retryable).toBe(false);
  });

  it("rejects a blank model name rather than sending an empty model", () => {
    expect(() => parseModelEndpoint("https://models.test/v1", "   ")).toThrow(TurnError);
  });

  it("pairs the stored base URL with the stored model name", () => {
    expect(parseModelEndpoint("https://api.openai.com/v1", "gpt-4o")).toEqual({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    });
    expect(parseModelEndpoint("https://models.test/v1/", "o4-mini")).toEqual({
      baseUrl: "https://models.test/v1",
      model: "o4-mini",
    });
  });
});

describe("parseModelReply", () => {
  it("parses bare JSON, fenced JSON, and fenced JSON inside prose", () => {
    expect(parseModelReply('{"messages":[]}')).toEqual({ messages: [] });
    expect(parseModelReply('```json\n{"messages":[]}\n```')).toEqual({ messages: [] });
    expect(parseModelReply('Here you go:\n```\n{"operations":[]}\n```\nanything else?')).toEqual({
      operations: [],
    });
  });

  it("throws malformed_response for unparseable replies", () => {
    expect(() => parseModelReply("no json here")).toThrowError(TurnError);
  });
});
