/**
 * Quorum Agent Protocol v1 — wire types.
 *
 * Intentionally free of imports and runtime code so agent authors can vendor
 * this file verbatim. Shapes under /v1/ never change incompatibly; new fields
 * are only ever added as optional.
 */

/** What the agent is allowed to do in this turn. */
export type AgentCapability = "message" | "artifact.create" | "artifact.patch" | "proposal.create";

/** Why the agent is being called. */
export type TriggerType = "mention" | "broadcast" | "proposal_approved" | "schedule";

export interface TurnTrigger {
  type: TriggerType;
}

export type ArtifactType = "doc" | "table";

/** One entry of the board's group chat, as seen by the agent. */
export interface TurnMessage {
  role: "human" | "agent";
  authorId: string;
  name: string;
  content: string;
}

/** A canvas artifact, serialized for the agent. */
export interface TurnArtifact {
  id: string;
  type: ArtifactType;
  title: string;
  content: string;
}

/** A proposal that is still collecting votes when the turn is dispatched. */
export interface TurnOpenProposal {
  id: string;
  /**
   * Open set on purpose — e.g. "artifact.create", "artifact.patch",
   * "agent_prompt". New kinds may appear without a version bump.
   */
  kind: string;
  title: string;
  summary: string;
  authorId: string;
  authorKind: "human" | "agent";
  /** Unix epoch milliseconds. */
  createdAt: number;
  /** Unix epoch milliseconds. */
  expiresAt: number;
}

export interface TurnContext {
  messages: TurnMessage[];
  artifacts: TurnArtifact[];
  openProposals: TurnOpenProposal[];
}

export interface TurnAgent {
  id: string;
  name: string;
}

/**
 * The POST body Quorum sends to an agent endpoint. Every request is signed
 * with the X-Quorum-Signature header — see ./signature for verification.
 * Retries reuse the same turnId; agents must be idempotent on it.
 */
export interface TurnPayload {
  turnId: string;
  boardId: string;
  agent: TurnAgent;
  trigger: TurnTrigger;
  context: TurnContext;
  capabilities: AgentCapability[];
}

/** Any JSON-serializable value (used by RFC 6902 patch operations). */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// RFC 6902 JSON Patch operations.
export interface JsonPatchAddOp {
  op: "add";
  path: string;
  value: JsonValue;
}

export interface JsonPatchRemoveOp {
  op: "remove";
  path: string;
}

export interface JsonPatchReplaceOp {
  op: "replace";
  path: string;
  value: JsonValue;
}

export interface JsonPatchMoveOp {
  op: "move";
  from: string;
  path: string;
}

export interface JsonPatchCopyOp {
  op: "copy";
  from: string;
  path: string;
}

export interface JsonPatchTestOp {
  op: "test";
  path: string;
  value: JsonValue;
}

export type JsonPatchOp =
  | JsonPatchAddOp
  | JsonPatchRemoveOp
  | JsonPatchReplaceOp
  | JsonPatchMoveOp
  | JsonPatchCopyOp
  | JsonPatchTestOp;

/** Stage a new artifact on the canvas (becomes a Proposal, never applied directly). */
export interface ArtifactCreateOperation {
  op: "artifact.create";
  type: ArtifactType;
  title: string;
  content: string;
}

/** Stage an edit to an existing artifact (becomes a Proposal, never applied directly). */
export interface ArtifactPatchOperation {
  op: "artifact.patch";
  artifactId: string;
  patch: JsonPatchOp[];
}

/** Ask another agent to act — prompting an agent always requires consensus. */
export interface ProposalPromptTarget {
  targetAgentId: string;
  content: string;
}

/**
 * Explicitly open a proposal: either wrap a nested artifact operation with a
 * human-readable title/summary, or prompt another agent on the board.
 */
export interface ProposalCreateOperation {
  op: "proposal.create";
  title: string;
  summary: string;
  operation?: ArtifactCreateOperation | ArtifactPatchOperation;
  prompt?: ProposalPromptTarget;
}

export type AgentOperation =
  ArtifactCreateOperation | ArtifactPatchOperation | ProposalCreateOperation;

/** A chat message the agent posts back into the board's thread. */
export interface AgentMessage {
  content: string;
}

/**
 * The response body an agent returns from a turn. Every operation is staged
 * as a Proposal and only applied once the board's consensus policy passes.
 */
export interface AgentResponse {
  messages?: AgentMessage[];
  operations?: AgentOperation[];
}
