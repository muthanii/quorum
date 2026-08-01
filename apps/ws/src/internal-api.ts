/**
 * Internal HTTP API, served on the SAME http server as the websocket (wired
 * as a Hocuspocus onRequest hook in server.ts). The worker calls these after
 * an agent turn:
 *
 * - POST /internal/agent-result — agent chat messages append to the doc;
 *   every operation is staged as a Proposal (NEVER applied directly); an
 *   agent message @mentioning another agent becomes an agent_prompt proposal
 *   instead of a direct enqueue.
 * - POST /internal/agent-status — mirrored into the doc's agentStatus map so
 *   roster pills update live.
 * - GET /healthz — no auth.
 *
 * Bearer auth with INTERNAL_API_SECRET (constant-time compare).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";
import type * as Y from "yjs";

import { idSchema, isId, newId } from "@quorum/shared/ids";
import { agentStatusSchema } from "@quorum/shared/schemas/agent";
import type { ConsensusPolicy } from "@quorum/shared/schemas/policy";
import type { Proposal, ProposalInput } from "@quorum/shared/schemas/proposal";
import { agentOperationSchema, agentMessageSchema } from "@quorum/shared/schemas/turn";
import { appendMessage, createProposalInDoc, setAgentStatus } from "@quorum/shared/yjs/doc";
import { messageSchema } from "@quorum/shared/schemas/message";

import { serializeError, type Logger } from "./log";
import type { AgentRecord, AuditStore, BoardStore } from "./stores";

const MAX_BODY_BYTES = 1024 * 1024; // matches MAX_AGENT_RESPONSE_BYTES

export const agentResultSchema = z.object({
  boardId: idSchema("board"),
  agentId: idSchema("agent"),
  turnId: idSchema("turn"),
  messages: z.array(agentMessageSchema).default([]),
  operations: z.array(agentOperationSchema).default([]),
});

export const agentStatusBodySchema = z.object({
  boardId: idSchema("board"),
  agentId: idSchema("agent"),
  status: agentStatusSchema,
});

/** Load a board doc (via a Hocuspocus direct connection) and mutate it. */
export interface DocGateway {
  withDoc<T>(boardId: string, fn: (doc: Y.Doc) => T): Promise<T>;
}

export interface InternalApiDeps {
  secret: string;
  docs: DocGateway;
  boards: Pick<BoardStore, "getBoard" | "getAgent" | "listAgents" | "setAgentStatus">;
  audit: Pick<AuditStore, "recordProposalCreated">;
  log: Logger;
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Find agents this content mentions: literal agt_ ids or case-insensitive
 * @Name occurrences. The author itself never counts.
 */
export function detectAgentMentions(
  content: string,
  boardAgents: readonly Pick<AgentRecord, "id" | "name">[],
  authorAgentId: string,
): string[] {
  const found = new Set<string>();
  const byId = new Set(boardAgents.map((agent) => agent.id));
  for (const match of content.matchAll(/agt_[A-Za-z0-9_-]{16}/g)) {
    if (byId.has(match[0])) found.add(match[0]);
  }
  const lower = content.toLowerCase();
  for (const agent of boardAgents) {
    if (lower.includes(`@${agent.name.toLowerCase()}`)) found.add(agent.id);
  }
  found.delete(authorAgentId);
  return [...found];
}

interface StagedTurnResult {
  messageIds: string[];
  proposals: Proposal[];
}

/**
 * Pure doc mutation for one agent result: append chat messages, stage every
 * operation (and every agent→agent mention) as a Proposal. Runs inside the
 * direct connection's transaction scope. Exposed for tests.
 */
export function stageAgentResult(input: {
  doc: Y.Doc;
  agent: Pick<AgentRecord, "id" | "name">;
  boardAgents: readonly Pick<AgentRecord, "id" | "name">[];
  messages: { content: string }[];
  operations: z.infer<typeof agentOperationSchema>[];
  policy: ConsensusPolicy;
  now: number;
}): StagedTurnResult {
  const { doc, agent, boardAgents, policy, now } = input;
  const expiresAt = now + policy.timeoutMs;
  const messageIds: string[] = [];
  const proposals: Proposal[] = [];

  const stage = (proposal: ProposalInput): void => {
    proposals.push(createProposalInDoc(doc, proposal));
  };

  const stagePrompt = (targetAgentId: string, content: string, title: string): void => {
    stage({
      id: newId("proposal"),
      kind: "agent_prompt",
      title,
      summary: `${agent.name} wants to prompt another agent. Prompting an agent always requires consensus.`,
      authorId: agent.id,
      authorKind: "agent",
      createdAt: now,
      expiresAt,
      status: "open",
      payload: { kind: "agent_prompt", targetAgentId, content },
      affectedArtifactIds: [],
    });
  };

  for (const message of input.messages) {
    const mentions = detectAgentMentions(message.content, boardAgents, agent.id);
    const parsed = messageSchema.parse({
      id: newId("message"),
      role: "agent",
      authorId: agent.id,
      name: agent.name,
      content: message.content,
      createdAt: now,
      mentions,
    });
    appendMessage(doc, parsed);
    messageIds.push(parsed.id);
    for (const targetAgentId of mentions) {
      const target = boardAgents.find((candidate) => candidate.id === targetAgentId);
      stagePrompt(targetAgentId, message.content, `Prompt ${target?.name ?? targetAgentId}`);
    }
  }

  for (const operation of input.operations) {
    if (operation.op === "artifact.create") {
      stage({
        id: newId("proposal"),
        kind: "artifact_create",
        title: `Create "${operation.title}"`,
        summary: `${agent.name} proposes a new ${operation.type} artifact.`,
        authorId: agent.id,
        authorKind: "agent",
        createdAt: now,
        expiresAt,
        status: "open",
        payload: { kind: "artifact_create", operation },
        // Pre-allocate the artifact id so approval reuses it (stable dashed
        // outline target across the proposal's life).
        affectedArtifactIds: [newId("artifact")],
      });
    } else if (operation.op === "artifact.patch") {
      stage({
        id: newId("proposal"),
        kind: "artifact_patch",
        title: "Edit artifact",
        summary: `${agent.name} proposes an edit (${operation.patch.length} change${operation.patch.length === 1 ? "" : "s"}).`,
        authorId: agent.id,
        authorKind: "agent",
        createdAt: now,
        expiresAt,
        status: "open",
        payload: { kind: "artifact_patch", operation },
        affectedArtifactIds: isId("artifact", operation.artifactId) ? [operation.artifactId] : [],
      });
    } else {
      // proposal.create — exactly one of operation | prompt (schema-enforced).
      if (operation.prompt !== undefined) {
        stage({
          id: newId("proposal"),
          kind: "agent_prompt",
          title: operation.title,
          summary: operation.summary,
          authorId: agent.id,
          authorKind: "agent",
          createdAt: now,
          expiresAt,
          status: "open",
          payload: {
            kind: "agent_prompt",
            targetAgentId: operation.prompt.targetAgentId,
            content: operation.prompt.content,
          },
          affectedArtifactIds: [],
        });
      } else if (operation.operation !== undefined) {
        const nested = operation.operation;
        if (nested.op === "artifact.create") {
          stage({
            id: newId("proposal"),
            kind: "artifact_create",
            title: operation.title,
            summary: operation.summary,
            authorId: agent.id,
            authorKind: "agent",
            createdAt: now,
            expiresAt,
            status: "open",
            payload: { kind: "artifact_create", operation: nested },
            affectedArtifactIds: [newId("artifact")],
          });
        } else {
          stage({
            id: newId("proposal"),
            kind: "artifact_patch",
            title: operation.title,
            summary: operation.summary,
            authorId: agent.id,
            authorKind: "agent",
            createdAt: now,
            expiresAt,
            status: "open",
            payload: { kind: "artifact_patch", operation: nested },
            affectedArtifactIds: isId("artifact", nested.artifactId) ? [nested.artifactId] : [],
          });
        }
      }
    }
  }

  return { messageIds, proposals };
}

export interface InternalApi {
  /** Returns true when the request was handled (server.ts then stops the hook chain). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createInternalApi(deps: InternalApiDeps): InternalApi {
  const now = deps.now ?? Date.now;
  const secretDigest = createHash("sha256").update(deps.secret).digest();

  function isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const provided = createHash("sha256").update(header.slice("Bearer ".length)).digest();
    return timingSafeEqual(provided, secretDigest);
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new HttpError(400, "request body is not valid JSON");
    }
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function handleAgentResult(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = agentResultSchema.parse(await readJsonBody(req));
    const agent = await deps.boards.getAgent(body.boardId, body.agentId);
    if (agent === null) throw new HttpError(404, "agent is not on this board");
    const board = await deps.boards.getBoard(body.boardId);
    if (board === null) throw new HttpError(404, "board not found");
    const boardAgents = await deps.boards.listAgents(body.boardId);

    const staged = await deps.docs.withDoc(body.boardId, (doc) =>
      stageAgentResult({
        doc,
        agent,
        boardAgents,
        messages: body.messages,
        operations: body.operations,
        policy: board.policy,
        now: now(),
      }),
    );

    for (const proposal of staged.proposals) {
      try {
        await deps.audit.recordProposalCreated(body.boardId, proposal);
      } catch (error) {
        deps.log.error("failed to audit staged proposal", {
          boardId: body.boardId,
          proposalId: proposal.id,
          ...serializeError(error),
        });
      }
    }

    deps.log.info("agent result staged", {
      boardId: body.boardId,
      agentId: body.agentId,
      turnId: body.turnId,
      messages: staged.messageIds.length,
      proposals: staged.proposals.length,
    });
    sendJson(res, 200, {
      ok: true,
      messageIds: staged.messageIds,
      proposalIds: staged.proposals.map((proposal) => proposal.id),
    });
  }

  async function handleAgentStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = agentStatusBodySchema.parse(await readJsonBody(req));
    const agent = await deps.boards.getAgent(body.boardId, body.agentId);
    if (agent === null) throw new HttpError(404, "agent is not on this board");
    await deps.boards.setAgentStatus(body.agentId, body.status);
    await deps.docs.withDoc(body.boardId, (doc) => {
      setAgentStatus(doc, body.agentId, body.status, now());
    });
    deps.log.info("agent status updated", {
      boardId: body.boardId,
      agentId: body.agentId,
      status: body.status,
    });
    sendJson(res, 200, { ok: true });
  }

  return {
    async handle(req, res) {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (path === "/healthz") {
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (!path.startsWith("/internal/")) return false;

      try {
        if (!isAuthorized(req)) throw new HttpError(401, "unauthorized");
        if (req.method !== "POST") throw new HttpError(405, "method not allowed");
        if (path === "/internal/agent-result") {
          await handleAgentResult(req, res);
        } else if (path === "/internal/agent-status") {
          await handleAgentStatus(req, res);
        } else {
          throw new HttpError(404, "not found");
        }
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { ok: false, error: error.message });
        } else if (error instanceof z.ZodError) {
          sendJson(res, 400, { ok: false, error: "invalid request body", issues: error.issues });
        } else {
          deps.log.error("internal api request failed", { path, ...serializeError(error) });
          sendJson(res, 500, { ok: false, error: "internal error" });
        }
      }
      return true;
    },
  };
}
