/**
 * REST wire types shared by the route handlers (producers) and the typed
 * client + TanStack hooks (consumers). Everything here is JSON-safe; dates
 * travel as Unix epoch milliseconds.
 *
 * Credentials NEVER appear in these shapes — agents carry only the
 * display-safe maskedKey suffix.
 */
import type { AgentKind, AgentStatus } from "@quorum/shared/schemas/agent";
import type { MemberRole } from "@quorum/shared/schemas/member";
import type { ConsensusPolicy } from "@quorum/shared/schemas/policy";
import type { Proposal } from "@quorum/shared/schemas/proposal";

export interface BoardDto {
  id: string;
  name: string;
  ownerId: string;
  policy: ConsensusPolicy;
  createdAt: number;
}

export interface BoardMemberDto {
  /** usr_… — the doc's member/vote key space (ws token `sub` uses the same id). */
  userId: string;
  name: string;
  role: MemberRole;
  /** Identity color (colorForUser) — same on every client. */
  color: string;
  lastSeenAt: number | null;
  joinedAt: number;
}

export interface BoardAgentDto {
  id: string;
  ownerId: string;
  name: string;
  kind: AgentKind;
  /**
   * Host only, never the full URL: a path or query string can carry the
   * agent's own capability token (a Zapier catch hook, `?key=…`), and every
   * board member — including viewer guests from a share link — reads this.
   */
  endpointHost: string;
  /** Display-safe suffix like "…abc4"; null when no credential is stored. */
  maskedKey: string | null;
  status: AgentStatus;
  createdAt: number;
}

export interface BoardSelfDto {
  id: string;
  name: string;
  role: MemberRole;
  color: string;
}

/** GET /api/boards/:boardId — the full initial payload for a board page. */
export interface BoardDetailDto {
  board: BoardDto;
  members: BoardMemberDto[];
  agents: BoardAgentDto[];
  self: BoardSelfDto;
}

export interface CreateBoardInput {
  name?: string;
}

export interface CreateBoardResponse {
  board: BoardDto;
}

export interface ListBoardsResponse {
  boards: BoardDto[];
}

/** POST /api/boards/:boardId/token — board websocket auth token. */
export interface BoardTokenResponse {
  token: string;
  /** Unix epoch ms when the token expires (10 minutes out). */
  expiresAt: number;
}

export interface CreateInviteInput {
  role: "editor" | "viewer";
}

export interface CreateInviteResponse {
  token: string;
  role: "editor" | "viewer";
  /** One-click share link: NEXT_PUBLIC_APP_URL/i/<token>. */
  url: string;
}

export interface ConnectAgentInput {
  name: string;
  kind: AgentKind;
  endpointUrl: string;
  /** Bearer token / API key — sent once, encrypted at rest, never returned. */
  secret?: string;
  /** Model name for kind "model". */
  model?: string;
}

/**
 * REST cannot write the Y.Doc (only ws clients and the ws server hold the
 * doc), so staged proposals come back as data: the CLIENT must call
 * createProposalInDoc(doc, proposal) with this exact object to stage it.
 */
export interface ConnectAgentResponse {
  agent: BoardAgentDto;
  /**
   * The per-agent webhook signing secret, returned exactly ONCE at creation
   * so the user can configure verification on their side. Never retrievable
   * again; stored encrypted.
   */
  signingSecret: string;
  proposal: Proposal;
}

export interface RemoveAgentResponse {
  proposal: Proposal;
}
