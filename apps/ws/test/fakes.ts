/**
 * In-memory fakes for the injectable store/queue interfaces — unit tests
 * never touch Postgres or Redis.
 */
import type { ConsensusPolicy } from "@quorum/shared/schemas/policy";

import type { AgentRecord, AuditStore, BoardRecord, BoardStore, MemberRecord } from "../src/stores";
import type { AgentTurnJob, TurnQueue } from "../src/turns";

export interface FakeBoards extends BoardStore {
  board: BoardRecord;
  members: MemberRecord[];
  agents: AgentRecord[];
  policyUpdates: ConsensusPolicy[];
  statusUpdates: { agentId: string; status: AgentRecord["status"] }[];
  removedAgentIds: string[];
  touched: { boardId: string; userIds: string[] }[];
}

export function makeFakeBoards(init: {
  board: BoardRecord;
  members?: MemberRecord[];
  agents?: AgentRecord[];
}): FakeBoards {
  const fake: FakeBoards = {
    board: init.board,
    members: init.members ?? [],
    agents: init.agents ?? [],
    policyUpdates: [],
    statusUpdates: [],
    removedAgentIds: [],
    touched: [],

    async getBoard(boardId) {
      return boardId === fake.board.id ? { ...fake.board } : null;
    },
    async updateBoardPolicy(boardId, policy) {
      if (boardId === fake.board.id) fake.board = { ...fake.board, policy };
      fake.policyUpdates.push(policy);
    },
    async listMembers(boardId) {
      return boardId === fake.board.id ? [...fake.members] : [];
    },
    async touchMembers(boardId, userIds) {
      fake.touched.push({ boardId, userIds });
    },
    async listAgents(boardId) {
      return fake.agents.filter((agent) => agent.boardId === boardId);
    },
    async getAgent(boardId, agentId) {
      return fake.agents.find((agent) => agent.boardId === boardId && agent.id === agentId) ?? null;
    },
    async setAgentStatus(agentId, status) {
      fake.statusUpdates.push({ agentId, status });
      fake.agents = fake.agents.map((agent) =>
        agent.id === agentId ? { ...agent, status } : agent,
      );
    },
    async removeAgent(agentId) {
      fake.removedAgentIds.push(agentId);
      fake.agents = fake.agents.filter((agent) => agent.id !== agentId);
    },
  };
  return fake;
}

export interface FakeAudit extends AuditStore {
  created: Parameters<AuditStore["recordProposalCreated"]>[];
  resolutions: Parameters<AuditStore["recordResolution"]>[0][];
}

export function makeFakeAudit(): FakeAudit {
  const fake: FakeAudit = {
    created: [],
    resolutions: [],
    async recordProposalCreated(boardId, proposal) {
      fake.created.push([boardId, proposal]);
    },
    async recordResolution(input) {
      fake.resolutions.push(input);
    },
  };
  return fake;
}

export interface FakeQueue extends TurnQueue {
  jobs: AgentTurnJob[];
}

export function makeFakeQueue(): FakeQueue {
  const fake: FakeQueue = {
    jobs: [],
    async add(job) {
      fake.jobs.push(job);
    },
  };
  return fake;
}
