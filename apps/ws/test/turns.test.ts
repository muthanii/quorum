import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { CHAT_CONTEXT_TAIL } from "@quorum/shared/constants";
import { newId } from "@quorum/shared/ids";
import type { MessageInput } from "@quorum/shared/schemas/message";
import type { ProposalInput } from "@quorum/shared/schemas/proposal";
import {
  appendMessage,
  createArtifactInDoc,
  createProposalInDoc,
  listMessages,
  setAgentStatus,
  setProposalStatus,
} from "@quorum/shared/yjs/doc";

import { nullLogger } from "../src/log";
import {
  createTurnRateLimiter,
  type RateLimitVerdict,
  type TurnRateLimiter,
} from "../src/rate-limit";
import type { AgentRecord } from "../src/stores";
import { TurnDispatcher, materializeTurnContext } from "../src/turns";
import { makeFakeBoards, makeFakeQueue } from "./fakes";

const NOW = 1_753_400_000_000;
const boardId = newId("board");

function humanMessage(content: string, mentions: string[] = []): MessageInput {
  return {
    id: newId("message"),
    role: "human",
    authorId: newId("user"),
    name: "Dana",
    content,
    createdAt: NOW,
    mentions,
  };
}

function agentRecord(name: string, status: AgentRecord["status"] = "ready"): AgentRecord {
  return { id: newId("agent"), boardId, name, kind: "webhook", status };
}

function openProposal(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    id: newId("proposal"),
    kind: "artifact_create",
    title: "Create brief",
    summary: "New doc",
    authorId: newId("agent"),
    authorKind: "agent",
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    status: "open",
    payload: {
      kind: "artifact_create",
      operation: { op: "artifact.create", type: "doc", title: "Brief", content: "# Brief" },
    },
    ...overrides,
  };
}

describe("materializeTurnContext", () => {
  it("serializes messages (sans system), artifacts, and open proposals", () => {
    const doc = new Y.Doc();
    appendMessage(doc, humanMessage("hello agents"));
    appendMessage(doc, {
      id: newId("message"),
      role: "system",
      authorId: "system",
      name: "Quorum",
      content: "noise",
      createdAt: NOW,
    });
    const agentId = newId("agent");
    appendMessage(doc, {
      id: newId("message"),
      role: "agent",
      authorId: agentId,
      name: "Researcher",
      content: "on it",
      createdAt: NOW,
    });

    const docArtifactId = newId("artifact");
    createArtifactInDoc(doc, {
      id: docArtifactId,
      meta: { type: "doc", title: "Brief", x: 0, y: 0, w: 480, h: 400, createdAt: NOW },
      body: "# Brief",
    });
    const tableArtifactId = newId("artifact");
    createArtifactInDoc(doc, {
      id: tableArtifactId,
      meta: { type: "table", title: "Data", x: 0, y: 0, w: 560, h: 320, createdAt: NOW },
      body: { cols: ["a"], rows: [{ a: "1" }] },
    });

    const open = createProposalInDoc(doc, openProposal());
    const resolved = createProposalInDoc(doc, openProposal());
    setProposalStatus(doc, resolved.id, "applied");

    const context = materializeTurnContext(doc);

    expect(context.messages).toEqual([
      { role: "human", authorId: expect.any(String), name: "Dana", content: "hello agents" },
      { role: "agent", authorId: agentId, name: "Researcher", content: "on it" },
    ]);
    expect(context.artifacts).toHaveLength(2);
    expect(context.artifacts.find((a) => a.id === docArtifactId)).toEqual({
      id: docArtifactId,
      type: "doc",
      title: "Brief",
      content: "# Brief",
    });
    const table = context.artifacts.find((a) => a.id === tableArtifactId);
    expect(table?.type).toBe("table");
    expect(JSON.parse(table?.content ?? "")).toEqual({ cols: ["a"], rows: [{ a: "1" }] });
    expect(context.openProposals).toHaveLength(1);
    expect(context.openProposals[0]?.id).toBe(open.id);
  });

  it("caps the message tail at CHAT_CONTEXT_TAIL", () => {
    const doc = new Y.Doc();
    for (let i = 0; i < CHAT_CONTEXT_TAIL + 10; i++) {
      appendMessage(doc, humanMessage(`m${i}`));
    }
    const context = materializeTurnContext(doc);
    expect(context.messages.length).toBeLessThanOrEqual(CHAT_CONTEXT_TAIL);
    expect(context.messages.at(-1)?.content).toBe(`m${CHAT_CONTEXT_TAIL + 9}`);
  });
});

function setup(agents: AgentRecord[], limiter?: TurnRateLimiter) {
  const doc = new Y.Doc();
  const boards = makeFakeBoards({
    board: {
      id: boardId,
      ownerUserId: newId("user"),
      policy: {
        rule: "unanimous",
        quorum: "active",
        timeoutMs: 300_000,
        onTimeout: "reject",
        vetoIsFinal: true,
        autoApproveOwnProposals: false,
      },
    },
    agents,
  });
  const queue = makeFakeQueue();
  const dispatcher = new TurnDispatcher({
    boards,
    queue,
    log: nullLogger(),
    limiter,
    now: () => NOW,
  });
  dispatcher.attach(boardId, doc);
  return { doc, boards, queue, dispatcher };
}

describe("TurnDispatcher mention → jobs", () => {
  it("enqueues one mention job per mentioned ready agent, skipping others", async () => {
    const ready = agentRecord("Researcher");
    const degraded = agentRecord("Flaky", "degraded");
    const unapproved = agentRecord("Pending");
    const { doc, queue, dispatcher } = setup([ready, degraded, unapproved]);
    // Participation flag: only ready + degraded ever got an agentStatus entry.
    setAgentStatus(doc, ready.id, "ready", NOW);
    setAgentStatus(doc, degraded.id, "degraded", NOW);

    appendMessage(doc, humanMessage("please help", [ready.id, degraded.id, unapproved.id]));
    await dispatcher.idle(boardId);

    expect(queue.jobs).toHaveLength(1);
    const job = queue.jobs[0];
    expect(job?.agentId).toBe(ready.id);
    expect(job?.trigger).toEqual({ type: "mention" });
    expect(job?.boardId).toBe(boardId);
    expect(job?.turnId).toMatch(/^trn_/);
    expect(job?.context.messages.at(-1)?.content).toBe("please help");
    expect(job?.capabilities).toContain("artifact.create");
  });

  it('broadcast mentions ["*"] fan out to every ready agent with trigger "broadcast"', async () => {
    const a = agentRecord("A");
    const b = agentRecord("B");
    const degraded = agentRecord("C", "degraded");
    const { doc, queue, dispatcher } = setup([a, b, degraded]);
    setAgentStatus(doc, a.id, "ready", NOW);
    setAgentStatus(doc, b.id, "ready", NOW);
    setAgentStatus(doc, degraded.id, "degraded", NOW);

    appendMessage(doc, humanMessage("everyone!", ["*"]));
    await dispatcher.idle(boardId);

    expect(queue.jobs.map((job) => job.agentId).sort()).toEqual([a.id, b.id].sort());
    expect(new Set(queue.jobs.map((job) => job.trigger.type))).toEqual(new Set(["broadcast"]));
    // Distinct turn ids per agent — retries must not collide across agents.
    expect(new Set(queue.jobs.map((job) => job.turnId)).size).toBe(2);
  });

  it("ignores agent-authored and mention-free messages", async () => {
    const ready = agentRecord("Researcher");
    const { doc, queue, dispatcher } = setup([ready]);
    setAgentStatus(doc, ready.id, "ready", NOW);

    appendMessage(doc, humanMessage("no mentions here"));
    appendMessage(doc, {
      id: newId("message"),
      role: "agent",
      authorId: ready.id,
      name: "Researcher",
      content: "agent talking",
      mentions: [ready.id],
      createdAt: NOW,
    });
    await dispatcher.idle(boardId);

    expect(queue.jobs).toHaveLength(0);
  });

  it("does not re-dispatch chat history present before attach", async () => {
    const ready = agentRecord("Researcher");
    const doc = new Y.Doc();
    setAgentStatus(doc, ready.id, "ready", NOW);
    appendMessage(doc, humanMessage("old mention", [ready.id]));

    const boards = makeFakeBoards({
      board: {
        id: boardId,
        ownerUserId: newId("user"),
        policy: {
          rule: "unanimous",
          quorum: "active",
          timeoutMs: 300_000,
          onTimeout: "reject",
          vetoIsFinal: true,
          autoApproveOwnProposals: false,
        },
      },
      agents: [ready],
    });
    const queue = makeFakeQueue();
    const dispatcher = new TurnDispatcher({ boards, queue, log: nullLogger() });
    dispatcher.attach(boardId, doc);

    appendMessage(doc, humanMessage("new mention", [ready.id]));
    await dispatcher.idle(boardId);

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.context.messages.at(-1)?.content).toBe("new mention");
  });

  it("dedupes repeated mentions of the same agent in one message", async () => {
    const ready = agentRecord("Researcher");
    const { doc, queue, dispatcher } = setup([ready]);
    setAgentStatus(doc, ready.id, "ready", NOW);

    appendMessage(doc, humanMessage("hi", [ready.id, ready.id]));
    await dispatcher.idle(boardId);

    expect(queue.jobs).toHaveLength(1);
  });
});

/** Allows the first `budget` turns of the run, then refuses like the real limiter. */
function stubLimiter(budget: number): TurnRateLimiter & { calls: number } {
  const stub = {
    calls: 0,
    async checkTurn(): Promise<RateLimitVerdict> {
      stub.calls += 1;
      if (stub.calls <= budget) return { allowed: true };
      return {
        allowed: false,
        scope: "agent",
        limit: budget,
        windowMs: 60_000,
        firstOverLimit: stub.calls === budget + 1,
      };
    },
  };
  return stub;
}

function systemMessages(doc: Y.Doc): string[] {
  return listMessages(doc)
    .filter((message) => message.role === "system")
    .map((message) => message.content);
}

describe("TurnDispatcher rate limiting", () => {
  it("enqueues while under the limit, and says nothing in chat", async () => {
    const ready = agentRecord("Researcher");
    const { doc, queue, dispatcher } = setup([ready], stubLimiter(2));
    setAgentStatus(doc, ready.id, "ready", NOW);

    appendMessage(doc, humanMessage("hi", [ready.id]));
    await dispatcher.idle(boardId);

    expect(queue.jobs).toHaveLength(1);
    expect(systemMessages(doc)).toEqual([]);
  });

  it("drops the turn over the limit and explains it in chat", async () => {
    const ready = agentRecord("Researcher");
    const { doc, queue, dispatcher } = setup([ready], stubLimiter(1));
    setAgentStatus(doc, ready.id, "ready", NOW);

    appendMessage(doc, humanMessage("first", [ready.id]));
    await dispatcher.idle(boardId);
    appendMessage(doc, humanMessage("spam", [ready.id]));
    await dispatcher.idle(boardId);

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.context.messages.at(-1)?.content).toBe("first");
    const notices = systemMessages(doc);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Researcher");
    expect(notices[0]).toContain("rate limited");
  });

  it("does not repeat the notice for every dropped turn in the window", async () => {
    const ready = agentRecord("Researcher");
    const { doc, queue, dispatcher } = setup([ready], stubLimiter(0));
    setAgentStatus(doc, ready.id, "ready", NOW);

    for (let i = 0; i < 5; i++) appendMessage(doc, humanMessage(`spam ${i}`, [ready.id]));
    await dispatcher.idle(boardId);

    expect(queue.jobs).toHaveLength(0);
    expect(systemMessages(doc)).toHaveLength(1);
  });

  it("still enqueues when the limiter's store is down", async () => {
    const ready = agentRecord("Researcher");
    const failOpen = createTurnRateLimiter({
      redis: {
        async eval() {
          throw new Error("ECONNREFUSED");
        },
      },
      log: nullLogger(),
    });
    const { doc, queue, dispatcher } = setup([ready], failOpen);
    setAgentStatus(doc, ready.id, "ready", NOW);

    appendMessage(doc, humanMessage("hi", [ready.id]));
    await dispatcher.idle(boardId);

    expect(queue.jobs).toHaveLength(1);
    expect(systemMessages(doc)).toEqual([]);
  });

  it("rate limits an approved agent_prompt turn too, visibly", async () => {
    const target = agentRecord("Writer");
    const { doc, queue, dispatcher } = setup([target], stubLimiter(0));
    setAgentStatus(doc, target.id, "ready", NOW);

    const enqueued = await dispatcher.enqueueProposalApprovedTurn({
      boardId,
      doc,
      targetAgentId: target.id,
      prompt: { authorId: newId("user"), authorKind: "human", content: "draft it" },
    });

    expect(enqueued).toBe(false);
    expect(queue.jobs).toHaveLength(0);
    expect(systemMessages(doc)[0]).toContain("Writer");
  });
});
