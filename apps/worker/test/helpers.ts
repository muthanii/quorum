/**
 * Shared fixtures for the worker contract tests: a local node:http mock agent
 * server, Map-backed idempotency stub, in-memory agent store, and a fetch
 * wrapper that rewrites the fake public origins the SSRF guard approves onto
 * the local server. No live Postgres or Redis anywhere.
 */
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

import { encryptSecret } from "@quorum/db/crypto";
import { type AgentRow } from "@quorum/db/schema";
import { newId } from "@quorum/shared/ids";

import { createLogger, type Logger } from "../src/log";
import { type Resolver } from "../src/ssrf";
import { type AgentStore } from "../src/store";
import { type IdempotencyStore, type TurnJobData } from "../src/turn";

// Deterministic test-only key so @quorum/db/crypto works without real env.
process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export const PUBLIC_IPV4 = "93.184.216.34";
export const SIGNING_SECRET = "whsec_test_signing_secret";
export const AGENT_BEARER = "agent-bearer-token";
export const INTERNAL_SECRET = "internal-api-secret-for-tests";

/** Resolver that answers every hostname with one public IPv4 address. */
export function publicResolver(address: string = PUBLIC_IPV4): Resolver {
  return async () => [{ address, family: 4 }];
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface MockServer {
  /** http://127.0.0.1:<port> */
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type MockHandler = (req: RecordedRequest, res: ServerResponse) => void;

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    // A client abort mid-response (timeout/oversize tests) is expected here.
    res.on("error", () => undefined);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock server has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Responds 200 JSON — the usual happy mock for agent and ws endpoints. */
export function jsonHandler(status: number, body: unknown): MockHandler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

/**
 * `typeof fetch` that rewrites origins (e.g. "https://agent.test" →
 * "http://127.0.0.1:<port>") so the SSRF guard sees a public https URL while
 * the request lands on the local mock. Everything else passes through.
 */
export function rewriteFetch(map: Record<string, string>): typeof fetch {
  return async (input, init) => {
    const original = new URL(input instanceof Request ? input.url : String(input));
    const target = map[original.origin];
    if (target === undefined) return fetch(original, init);
    return fetch(new URL(original.pathname + original.search, target), init);
  };
}

/** A fetch that fails the test if anything calls it (SSRF-rejection cases). */
export const neverFetch: typeof fetch = async () => {
  throw new Error("fetch must not be called for a rejected endpoint");
};

export function fakeIdempotency(): IdempotencyStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async set(key, value, _secondsToken, _seconds, _nx) {
      if (map.has(key)) return null;
      map.set(key, value);
      return "OK";
    },
    async get(key) {
      return map.get(key) ?? null;
    },
  };
}

export function fakeAgentStore(
  rows: AgentRow[],
): AgentStore & { statusUpdates: Array<{ agentId: string; status: string }> } {
  const statusUpdates: Array<{ agentId: string; status: string }> = [];
  return {
    statusUpdates,
    async getAgent(agentId) {
      return rows.find((row) => row.id === agentId) ?? null;
    },
    async setAgentStatus(agentId, status) {
      statusUpdates.push({ agentId, status });
    },
  };
}

export function makeAgentRow(
  overrides: Partial<AgentRow> & {
    credential?: string | null;
    signingSecret?: string | null;
  } = {},
): AgentRow {
  const { credential = AGENT_BEARER, signingSecret = SIGNING_SECRET, ...rest } = overrides;
  const enc = credential === null ? null : encryptSecret(credential);
  const sig = signingSecret === null ? null : encryptSecret(signingSecret);
  return {
    id: newId("agent"),
    boardId: newId("board"),
    ownerId: newId("user"),
    name: "Researcher",
    kind: "webhook",
    endpointUrl: "https://agent.test/hook",
    model: null,
    encryptedCredential: enc?.ciphertext ?? null,
    credentialIv: enc?.iv ?? null,
    credentialTag: enc?.tag ?? null,
    maskedKey: credential === null ? null : `…${credential.slice(-4)}`,
    encryptedSigningSecret: sig?.ciphertext ?? null,
    signingSecretIv: sig?.iv ?? null,
    signingSecretTag: sig?.tag ?? null,
    status: "ready",
    createdAt: new Date(),
    ...rest,
  };
}

export function makeTurnJob(agent: AgentRow): TurnJobData {
  return {
    turnId: newId("turn"),
    boardId: agent.boardId,
    agentId: agent.id,
    trigger: { type: "mention" },
    context: {
      messages: [
        { role: "human", authorId: newId("user"), name: "Ada", content: "@Researcher go" },
      ],
      artifacts: [],
      openProposals: [],
    },
  };
}

/** requests[i] without non-null assertions — fails the test loudly instead. */
export function requestAt(server: MockServer, index: number): RecordedRequest {
  const request = server.requests[index];
  if (request === undefined) {
    throw new Error(`mock server recorded no request at index ${index}`);
  }
  return request;
}

export function captureLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({}, (line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { logger, lines };
}
