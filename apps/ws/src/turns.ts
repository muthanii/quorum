/**
 * Turn dispatch: watches each board's chat for new HUMAN messages that
 * @mention agents and enqueues BullMQ jobs on "agent-turns". The context is
 * fully materialized here from the doc (messages tail, artifacts, open
 * proposals) — the worker never opens a Y.Doc.
 *
 * Agent-authored messages never enqueue directly: an agent mentioning
 * another agent becomes an agent_prompt Proposal (internal-api.ts), and only
 * an approved proposal reaches this queue via enqueueProposalApprovedTurn.
 */
import type { z } from "zod";

import { CHAT_CONTEXT_TAIL } from "@quorum/shared/constants";
import { isId, newId } from "@quorum/shared/ids";
import { messageSchema, type Message } from "@quorum/shared/schemas/message";
import {
  getArtifacts,
  getChat,
  getProposals,
  listMessages,
  readAgentStatuses,
  readArtifact,
  readProposal,
} from "@quorum/shared/yjs/doc";
import type {
  agentCapabilitySchema,
  triggerTypeSchema,
  turnContextSchema,
  turnMessageSchema,
} from "@quorum/shared/schemas/turn";
import * as Y from "yjs";

import { serializeError, type Logger } from "./log";
import type { BoardStore } from "./stores";

// Wire types via the shared zod validators (apps/ws does not depend on
// @quorum/agent-protocol directly; the schemas are pinned to it).
type AgentCapability = z.infer<typeof agentCapabilitySchema>;
type TriggerType = z.infer<typeof triggerTypeSchema>;
type TurnContext = z.infer<typeof turnContextSchema>;
type TurnMessage = z.infer<typeof turnMessageSchema>;

/** Job payload for queue "agent-turns" (build brief "Queue"). */
export interface AgentTurnJob {
  turnId: string;
  boardId: string;
  agentId: string;
  trigger: { type: TriggerType };
  context: TurnContext;
  /**
   * The agents table has no capability column in v1, so every connected
   * agent gets the full set. Additive on top of the pinned payload shape.
   */
  capabilities: AgentCapability[];
}

export interface TurnQueue {
  add(job: AgentTurnJob): Promise<void>;
}

export const ALL_CAPABILITIES: AgentCapability[] = [
  "message",
  "artifact.create",
  "artifact.patch",
  "proposal.create",
];

export const BROADCAST_MENTION = "*";

/** Serialize the live doc into the agent-facing TurnContext. */
export function materializeTurnContext(doc: Y.Doc): TurnContext {
  const messages: TurnMessage[] = [];
  for (const message of listMessages(doc, CHAT_CONTEXT_TAIL)) {
    if (message.role === "system") continue;
    messages.push({
      role: message.role,
      authorId: message.authorId,
      name: message.name,
      content: message.content,
    });
  }

  const artifacts = [...getArtifacts(doc).keys()].flatMap((artifactId) => {
    const artifact = readArtifact(doc, artifactId);
    if (artifact === null) return [];
    return [
      {
        id: artifact.id,
        type: artifact.meta.type,
        title: artifact.meta.title,
        content: typeof artifact.body === "string" ? artifact.body : JSON.stringify(artifact.body),
      },
    ];
  });

  const openProposals = [...getProposals(doc).keys()].flatMap((proposalId) => {
    const proposal = readProposal(doc, proposalId);
    if (proposal === null || proposal.status !== "open") return [];
    return [
      {
        id: proposal.id,
        kind: proposal.kind,
        title: proposal.title,
        summary: proposal.summary,
        authorId: proposal.authorId,
        authorKind: proposal.authorKind,
        createdAt: proposal.createdAt,
        expiresAt: proposal.expiresAt,
      },
    ];
  });

  return { messages, artifacts, openProposals };
}

/**
 * An agent participates once its add_agent proposal applied — the ws server
 * then writes its entry into the doc's agentStatus map, which is therefore
 * the participation flag. requireReady additionally demands status "ready"
 * (mention/broadcast); proposal_approved turns tolerate "running".
 */
export function isAgentDispatchable(
  doc: Y.Doc,
  agentId: string,
  opts: { requireReady: boolean },
): boolean {
  const entry = readAgentStatuses(doc)[agentId];
  if (entry === undefined) return false;
  if (entry.status === "degraded") return false;
  return opts.requireReady ? entry.status === "ready" : true;
}

export interface TurnDispatcherDeps {
  boards: Pick<BoardStore, "listAgents" | "getAgent">;
  queue: TurnQueue;
  log: Logger;
}

interface AttachedBoard {
  doc: Y.Doc;
  chat: Y.Array<Y.Map<unknown>>;
  observer: () => void;
  /** Chat length already processed — history is never re-dispatched. */
  seen: number;
}

export class TurnDispatcher {
  private readonly attached = new Map<string, AttachedBoard>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: TurnDispatcherDeps) {}

  attach(boardId: string, doc: Y.Doc): void {
    if (this.attached.has(boardId)) return;
    const chat = getChat(doc);
    const observer = (): void => {
      this.schedule(boardId, () => this.processNewMessages(boardId));
    };
    chat.observe(observer);
    this.attached.set(boardId, { doc, chat, observer, seen: chat.length });
  }

  detach(boardId: string): void {
    const board = this.attached.get(boardId);
    if (board === undefined) return;
    try {
      board.chat.unobserve(board.observer);
    } catch {
      // The doc may already be destroyed by Hocuspocus unload — nothing to do.
    }
    this.attached.delete(boardId);
    this.chains.delete(boardId);
  }

  /** Await all currently-scheduled dispatch work for a board (tests). */
  async idle(boardId: string): Promise<void> {
    await (this.chains.get(boardId) ?? Promise.resolve());
  }

  /**
   * Enqueue the turn for an APPROVED agent_prompt proposal. The prompt is
   * appended to the context tail so the target agent always receives it,
   * even when it never appeared in chat (proposal.create with `prompt`).
   */
  async enqueueProposalApprovedTurn(input: {
    boardId: string;
    doc: Y.Doc;
    targetAgentId: string;
    prompt: { authorId: string; authorKind: "human" | "agent"; content: string };
  }): Promise<boolean> {
    const { boardId, doc, targetAgentId, prompt } = input;
    const target = await this.deps.boards.getAgent(boardId, targetAgentId);
    if (target === null) {
      this.deps.log.warn("approved agent_prompt targets an unknown agent", {
        boardId,
        targetAgentId,
      });
      return false;
    }
    if (!isAgentDispatchable(doc, targetAgentId, { requireReady: false })) {
      this.deps.log.warn("approved agent_prompt target is not dispatchable", {
        boardId,
        targetAgentId,
      });
      return false;
    }

    let authorName = "Member";
    if (prompt.authorKind === "agent") {
      const author = await this.deps.boards.getAgent(boardId, prompt.authorId);
      authorName = author?.name ?? "Agent";
    }

    const context = materializeTurnContext(doc);
    context.messages = [
      ...context.messages,
      {
        role: prompt.authorKind,
        authorId: prompt.authorId,
        name: authorName,
        content: prompt.content,
      },
    ].slice(-CHAT_CONTEXT_TAIL);

    await this.deps.queue.add({
      turnId: newId("turn"),
      boardId,
      agentId: targetAgentId,
      trigger: { type: "proposal_approved" },
      context,
      capabilities: [...ALL_CAPABILITIES],
    });
    return true;
  }

  /** Exposed for tests: mention/broadcast → jobs for one chat message. */
  async dispatchMessage(boardId: string, doc: Y.Doc, message: Message): Promise<AgentTurnJob[]> {
    if (message.role !== "human" || message.mentions.length === 0) return [];

    const agents = await this.deps.boards.listAgents(boardId);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));

    const broadcast = message.mentions.includes(BROADCAST_MENTION);
    const targetIds = broadcast
      ? agents.map((agent) => agent.id)
      : [...new Set(message.mentions.filter((id) => isId("agent", id)))];

    const jobs: AgentTurnJob[] = [];
    let context: TurnContext | null = null;
    for (const agentId of targetIds) {
      if (!byId.has(agentId)) {
        this.deps.log.warn("mention targets an agent not on this board", { boardId, agentId });
        continue;
      }
      if (!isAgentDispatchable(doc, agentId, { requireReady: true })) {
        this.deps.log.info("skipping agent that is not approved/ready", { boardId, agentId });
        continue;
      }
      context ??= materializeTurnContext(doc);
      jobs.push({
        turnId: newId("turn"),
        boardId,
        agentId,
        trigger: { type: broadcast ? "broadcast" : "mention" },
        context,
        capabilities: [...ALL_CAPABILITIES],
      });
    }

    for (const job of jobs) {
      await this.deps.queue.add(job);
      this.deps.log.info("agent turn enqueued", {
        boardId,
        agentId: job.agentId,
        turnId: job.turnId,
        trigger: job.trigger.type,
      });
    }
    return jobs;
  }

  private schedule(boardId: string, task: () => Promise<void>): void {
    const prev = this.chains.get(boardId) ?? Promise.resolve();
    const next = prev.then(task).catch((error: unknown) => {
      this.deps.log.error("turn dispatch failed", { boardId, ...serializeError(error) });
    });
    this.chains.set(boardId, next);
  }

  private async processNewMessages(boardId: string): Promise<void> {
    const board = this.attached.get(boardId);
    if (board === undefined) return;
    while (board.seen < board.chat.length) {
      const index = board.seen;
      board.seen += 1;
      const entry: unknown = board.chat.get(index);
      const json = entry instanceof Y.AbstractType ? entry.toJSON() : entry;
      const parsed = messageSchema.safeParse(json);
      if (!parsed.success) continue; // hostile/malformed peer write — skip
      await this.dispatchMessage(boardId, board.doc, parsed.data);
    }
  }
}
