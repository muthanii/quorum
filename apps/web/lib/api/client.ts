/**
 * Typed fetch client for the Quorum REST API. Browser-side (relative URLs);
 * server code talks to lib/server/* directly instead of going through HTTP.
 */
import type {
  BoardDetailDto,
  BoardTokenResponse,
  ConnectAgentInput,
  ConnectAgentResponse,
  CreateBoardInput,
  CreateBoardResponse,
  CreateInviteInput,
  CreateInviteResponse,
  ListBoardsResponse,
  RemoveAgentResponse,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  json?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
  });

  const text = await response.text();
  let data: unknown = null;
  if (text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const body = data as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? "request_failed",
      body?.error?.message ?? `Request failed with status ${response.status}.`,
    );
  }
  return data as T;
}

export const api = {
  createBoard(input: CreateBoardInput = {}): Promise<CreateBoardResponse> {
    return request("/api/boards", { method: "POST", json: input });
  },
  listBoards(): Promise<ListBoardsResponse> {
    return request("/api/boards");
  },
  getBoard(boardId: string): Promise<BoardDetailDto> {
    return request(`/api/boards/${encodeURIComponent(boardId)}`);
  },
  mintBoardToken(boardId: string): Promise<BoardTokenResponse> {
    return request(`/api/boards/${encodeURIComponent(boardId)}/token`, { method: "POST" });
  },
  createInvite(boardId: string, input: CreateInviteInput): Promise<CreateInviteResponse> {
    return request(`/api/boards/${encodeURIComponent(boardId)}/invites`, {
      method: "POST",
      json: input,
    });
  },
  connectAgent(boardId: string, input: ConnectAgentInput): Promise<ConnectAgentResponse> {
    return request(`/api/boards/${encodeURIComponent(boardId)}/agents`, {
      method: "POST",
      json: input,
    });
  },
  /** Execute an approved invite_member proposal — see claim-editor route. */
  claimEditor(boardId: string): Promise<{ role: string }> {
    return request(`/api/boards/${encodeURIComponent(boardId)}/members/claim-editor`, {
      method: "POST",
    });
  },
  removeAgent(boardId: string, agentId: string): Promise<RemoveAgentResponse> {
    return request(
      `/api/boards/${encodeURIComponent(boardId)}/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" },
    );
  },
};
