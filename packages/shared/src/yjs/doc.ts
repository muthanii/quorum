/**
 * Typed accessors over the board Y.Doc. Web clients and the ws server BOTH go
 * through these — nothing else touches raw doc keys, so the live document
 * shape stays consistent and migratable.
 *
 * Readers validate with zod and skip/return-null on malformed entries: any
 * editor client can write arbitrary bytes into a CRDT, so hostile or buggy
 * peers must not be able to crash the ws server or other clients.
 */
import * as Y from "yjs";
import type {
  ArtifactCreateOperation,
  ArtifactPatchOperation,
} from "@quorum/agent-protocol/v1/types";
import { z } from "zod";

import { newId } from "../ids";
import { agentStatusEntrySchema, type AgentStatus, type AgentStatusEntry } from "../schemas/agent";
import {
  artifactSchema,
  tableBodySchema,
  type Artifact,
  type ArtifactMeta,
  type TableBody,
} from "../schemas/artifact";
import { messageSchema, type Message, type MessageInput } from "../schemas/message";
import {
  proposalSchema,
  type Proposal,
  type ProposalInput,
  type ProposalStatus,
} from "../schemas/proposal";
import { voteEntrySchema, type VoteEntry, type VoteValue } from "../schemas/vote";
import { DOC_KEYS } from "./keys";
import { applyJsonPatch } from "./json-patch";
import { updateYText } from "./text";

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

export function getChat(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>(DOC_KEYS.chat);
}

/** Append one message to the group chat. Validates before writing. */
export function appendMessage(doc: Y.Doc, message: MessageInput): Message {
  const parsed = messageSchema.parse(message);
  doc.transact(() => {
    const entry = new Y.Map<unknown>(Object.entries({ ...parsed, mentions: [...parsed.mentions] }));
    getChat(doc).push([entry]);
  });
  return parsed;
}

/**
 * Read the chat tail (all messages when `limit` is omitted). Malformed
 * entries written by misbehaving peers are skipped.
 */
export function listMessages(doc: Y.Doc, limit?: number): Message[] {
  const chat = getChat(doc);
  const start = limit === undefined ? 0 : Math.max(0, chat.length - limit);
  const messages: Message[] = [];
  for (let i = start; i < chat.length; i++) {
    const entry: unknown = chat.get(i);
    const json = entry instanceof Y.AbstractType ? entry.toJSON() : entry;
    const parsed = messageSchema.safeParse(json);
    if (parsed.success) messages.push(parsed.data);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

export function getArtifacts(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(DOC_KEYS.artifacts);
}

export interface CreateArtifactInput {
  id: string;
  meta: ArtifactMeta;
  /** Text for "doc" artifacts, {cols, rows} for "table" artifacts. */
  body: string | TableBody;
}

function buildTableBody(body: TableBody): Y.Map<unknown> {
  const cols = new Y.Array<string>();
  cols.push([...body.cols]);
  const rows = new Y.Array<Y.Map<string>>();
  rows.push(body.rows.map((row) => new Y.Map<string>(Object.entries(row))));
  return new Y.Map<unknown>(Object.entries({ cols, rows }));
}

/**
 * Create an artifact under `input.id`. Validates the full artifact shape
 * (including body/type coherence) before any mutation.
 */
export function createArtifactInDoc(doc: Y.Doc, input: CreateArtifactInput): void {
  const parsed = artifactSchema.parse(input);
  doc.transact(() => {
    const artifact = new Y.Map<unknown>();
    artifact.set("meta", new Y.Map<unknown>(Object.entries(parsed.meta)));
    artifact.set(
      "body",
      typeof parsed.body === "string" ? new Y.Text(parsed.body) : buildTableBody(parsed.body),
    );
    getArtifacts(doc).set(parsed.id, artifact);
  });
}

/**
 * Snapshot one artifact as plain JSON (body: Y.Text → string, table → {cols,
 * rows}). Returns null when absent or malformed.
 */
export function readArtifact(doc: Y.Doc, artifactId: string): Artifact | null {
  const artifact = getArtifacts(doc).get(artifactId);
  if (!(artifact instanceof Y.Map)) return null;
  const meta: unknown = artifact.get("meta");
  const body: unknown = artifact.get("body");
  if (!(meta instanceof Y.Map)) return null;
  let bodyJson: unknown;
  if (body instanceof Y.Text) {
    bodyJson = body.toString();
  } else if (body instanceof Y.Map) {
    bodyJson = body.toJSON();
  } else {
    return null;
  }
  const parsed = artifactSchema.safeParse({ id: artifactId, meta: meta.toJSON(), body: bodyJson });
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// proposals
// ---------------------------------------------------------------------------

export function getProposals(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(DOC_KEYS.proposals);
}

export interface ProposalWithVotes extends Proposal {
  /** memberId → their vote. Live-tallied; each member writes only their key. */
  votes: Record<string, VoteEntry>;
}

/** Stage a proposal in the doc with an empty votes map. Validates first. */
export function createProposalInDoc(doc: Y.Doc, proposal: ProposalInput): Proposal {
  const parsed = proposalSchema.parse(proposal);
  doc.transact(() => {
    const entry = new Y.Map<unknown>(
      Object.entries({
        ...parsed,
        payload: structuredClone(parsed.payload),
        affectedArtifactIds: [...parsed.affectedArtifactIds],
        votes: new Y.Map<unknown>(),
      }),
    );
    getProposals(doc).set(parsed.id, entry);
  });
  return parsed;
}

/** Read one proposal + its live votes. Null when absent or malformed. */
export function readProposal(doc: Y.Doc, proposalId: string): ProposalWithVotes | null {
  const entry = getProposals(doc).get(proposalId);
  if (!(entry instanceof Y.Map)) return null;
  const { votes: rawVotes, ...rest } = entry.toJSON() as { votes?: unknown } & Record<
    string,
    unknown
  >;
  const parsed = proposalSchema.safeParse(rest);
  if (!parsed.success) return null;
  const votes: Record<string, VoteEntry> = {};
  if (rawVotes !== null && typeof rawVotes === "object") {
    for (const [memberId, vote] of Object.entries(rawVotes)) {
      const parsedVote = voteEntrySchema.safeParse(vote);
      if (parsedVote.success) votes[memberId] = parsedVote.data;
    }
  }
  return { ...parsed.data, votes };
}

/**
 * Record one member's vote. Writes ONLY that member's key in the votes map —
 * concurrent votes from different members merge without conflict, and the ws
 * server stays the sole author of everything else on the proposal.
 */
export function castVote(
  doc: Y.Doc,
  proposalId: string,
  memberId: string,
  value: VoteValue,
  at: number,
): boolean {
  const entry = getProposals(doc).get(proposalId);
  if (!(entry instanceof Y.Map)) return false;
  const votes: unknown = entry.get("votes");
  if (!(votes instanceof Y.Map)) return false;
  doc.transact(() => {
    votes.set(memberId, { value, at } satisfies VoteEntry);
  });
  return true;
}

/** ws-only: write the authoritative resolution status onto a proposal. */
export function setProposalStatus(doc: Y.Doc, proposalId: string, status: ProposalStatus): boolean {
  const entry = getProposals(doc).get(proposalId);
  if (!(entry instanceof Y.Map)) return false;
  doc.transact(() => {
    entry.set("status", status);
  });
  return true;
}

// ---------------------------------------------------------------------------
// agent status
// ---------------------------------------------------------------------------

export function getAgentStatusMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(DOC_KEYS.agentStatus);
}

/** ws-only: reflect an agent's roster status so pills update live. */
export function setAgentStatus(doc: Y.Doc, agentId: string, status: AgentStatus, at: number): void {
  doc.transact(() => {
    getAgentStatusMap(doc).set(agentId, { status, at } satisfies AgentStatusEntry);
  });
}

export function readAgentStatuses(doc: Y.Doc): Record<string, AgentStatusEntry> {
  const statuses: Record<string, AgentStatusEntry> = {};
  getAgentStatusMap(doc).forEach((value, agentId) => {
    const parsed = agentStatusEntrySchema.safeParse(value);
    if (parsed.success) statuses[agentId] = parsed.data;
  });
  return statuses;
}

// ---------------------------------------------------------------------------
// applying approved operations
// ---------------------------------------------------------------------------

/** What a JSON Patch may address on a "doc" artifact. */
const docPatchTargetSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string(),
});

/** What a JSON Patch may address on a "table" artifact. */
const tablePatchTargetSchema = tableBodySchema.extend({
  title: z.string().min(1).max(200),
});

const DEFAULT_SIZE: Record<"doc" | "table", { w: number; h: number }> = {
  doc: { w: 480, h: 400 },
  table: { w: 560, h: 320 },
};

export interface ApplyOperationContext {
  /** Unix epoch ms used as createdAt for created artifacts. */
  now: number;
  /** Reuse a pre-allocated id (e.g. recorded on the proposal) for creates. */
  artifactId?: string;
  /** Attributed author for created artifacts. */
  authorAgentId?: string;
}

function parseTableContent(content: string): TableBody {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('table artifact content must be JSON {"cols": [...], "rows": [...]}');
  }
  return tableBodySchema.parse(raw);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply an APPROVED artifact operation to the doc. Call this inside the ws
 * server's `doc.transact()` — it opens no transaction boundary of its own
 * (nested transacts collapse), so proposal application stays atomic.
 *
 * All validation happens BEFORE the first mutation: Yjs transactions do not
 * roll back on throw, so a failing operation must leave the doc untouched.
 *
 * Returns the affected artifact's id.
 */
export function applyOperationToDoc(
  doc: Y.Doc,
  operation: ArtifactCreateOperation | ArtifactPatchOperation,
  ctx: ApplyOperationContext,
): string {
  if (operation.op === "artifact.create") {
    const body: string | TableBody =
      operation.type === "doc" ? operation.content : parseTableContent(operation.content);
    const id = ctx.artifactId ?? newId("artifact");
    const count = getArtifacts(doc).size;
    const size = DEFAULT_SIZE[operation.type];
    const meta: ArtifactMeta = {
      type: operation.type,
      title: operation.title,
      // simple cascade so stacked creations don't fully overlap
      x: 120 + (count % 6) * 48,
      y: 120 + (count % 6) * 48,
      w: size.w,
      h: size.h,
      createdAt: ctx.now,
      ...(ctx.authorAgentId !== undefined ? { authorAgentId: ctx.authorAgentId } : {}),
    };
    createArtifactInDoc(doc, { id, meta, body });
    return id;
  }

  // artifact.patch — compute and validate the full next state first.
  const current = readArtifact(doc, operation.artifactId);
  if (current === null) {
    throw new Error(`artifact ${operation.artifactId} not found`);
  }
  const artifact = getArtifacts(doc).get(operation.artifactId);
  if (!(artifact instanceof Y.Map)) {
    throw new Error(`artifact ${operation.artifactId} not found`);
  }
  const meta = artifact.get("meta");
  const body = artifact.get("body");
  if (!(meta instanceof Y.Map)) {
    throw new Error(`artifact ${operation.artifactId} has no meta`);
  }

  if (current.meta.type === "doc") {
    if (!(body instanceof Y.Text)) {
      throw new Error(`artifact ${operation.artifactId} has no text body`);
    }
    const target = { title: current.meta.title, content: current.body as string };
    const next = docPatchTargetSchema.parse(applyJsonPatch(target, operation.patch));
    doc.transact(() => {
      if (next.title !== current.meta.title) meta.set("title", next.title);
      updateYText(body, next.content);
    });
    return operation.artifactId;
  }

  if (!(body instanceof Y.Map)) {
    throw new Error(`artifact ${operation.artifactId} has no table body`);
  }
  const currentBody = current.body as TableBody;
  const target = { title: current.meta.title, ...structuredClone(currentBody) };
  const next = tablePatchTargetSchema.parse(applyJsonPatch(target, operation.patch));
  doc.transact(() => {
    if (next.title !== current.meta.title) meta.set("title", next.title);
    const cols: unknown = body.get("cols");
    if (cols instanceof Y.Array && !sameJson(currentBody.cols, next.cols)) {
      cols.delete(0, cols.length);
      cols.push([...next.cols]);
    }
    const rows: unknown = body.get("rows");
    if (rows instanceof Y.Array && !sameJson(currentBody.rows, next.rows)) {
      rows.delete(0, rows.length);
      rows.push(next.rows.map((row) => new Y.Map<string>(Object.entries(row))));
    }
  });
  return operation.artifactId;
}
