/**
 * Postgres schema. Postgres holds identity, membership, encrypted agent
 * credentials, board metadata, Yjs snapshots/update log, and the immutable
 * proposal/vote audit trail. Live collaborative state (chat, artifacts, open
 * proposals) lives in the Y.Doc, never here.
 *
 * proposals_audit / votes_audit are append-only: they carry no cascading FKs
 * (nothing may ever delete an audit row, not even a board deletion) and this
 * package deliberately ships no delete helpers.
 */
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { newId } from "@quorum/shared/ids";
import { AGENT_KINDS, AGENT_STATUSES } from "@quorum/shared/schemas/agent";
import { MEMBER_ROLES } from "@quorum/shared/schemas/member";
import { DEFAULT_POLICY, type ConsensusPolicy } from "@quorum/shared/schemas/policy";
import {
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  type ProposalPayload,
} from "@quorum/shared/schemas/proposal";
import { VOTE_VALUES } from "@quorum/shared/schemas/vote";

/** drizzle-orm has no built-in bytea; postgres-js maps it to Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums (values come from @quorum/shared — the single domain vocabulary)
// ---------------------------------------------------------------------------

export const memberRoleEnum = pgEnum("member_role", MEMBER_ROLES);
export const agentKindEnum = pgEnum("agent_kind", AGENT_KINDS);
export const agentStatusEnum = pgEnum("agent_status", AGENT_STATUSES);
/** Invite links never grant "owner" — only editor or viewer. */
export const inviteRoleEnum = pgEnum("invite_role", ["editor", "viewer"]);
export const proposalKindEnum = pgEnum("proposal_kind", PROPOSAL_KINDS);
export const proposalStatusEnum = pgEnum("proposal_status", PROPOSAL_STATUSES);
export const proposalAuthorKindEnum = pgEnum("proposal_author_kind", ["human", "agent"]);
export const voteValueEnum = pgEnum("vote_value", VOTE_VALUES);

// ---------------------------------------------------------------------------
// Auth.js (@auth/drizzle-adapter) tables — standard adapter columns
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  // Has a default, so the adapter lets us mint prefixed ids instead of UUIDs.
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("user")),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<"oauth" | "oidc" | "email" | "webauthn">().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

// ---------------------------------------------------------------------------
// Boards & membership
// ---------------------------------------------------------------------------

export const boards = pgTable(
  "boards",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("board")),
    name: text("name").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    consensusPolicy: jsonb("consensus_policy")
      .$type<ConsensusPolicy>()
      .notNull()
      .$defaultFn(() => DEFAULT_POLICY),
    createdAt: createdAt(),
  },
  (table) => [index("boards_owner_id_idx").on(table.ownerId)],
);

export const boardMembers = pgTable(
  "board_members",
  {
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull(),
    /** Drives the "active" quorum window (seen within the last 5 min). */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.boardId, table.userId] }),
    index("board_members_user_id_idx").on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// Agents — the ONLY place credentials live, always encrypted (AES-256-GCM)
// ---------------------------------------------------------------------------

export const agents = pgTable(
  "agents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("agent")),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    kind: agentKindEnum("kind").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    /** Model name for kind "model" agents (e.g. "gpt-4o-mini"); null for webhooks. */
    model: text("model"),
    // Ciphertext + IV + auth tag from src/crypto.ts. Select these only to
    // decrypt server-side immediately before use — never serialize them into
    // an API response, a log line, or the Y.Doc.
    encryptedCredential: bytea("encrypted_credential"),
    credentialIv: bytea("credential_iv"),
    credentialTag: bytea("credential_tag"),
    /** Display-safe suffix like "…abc4" — the only credential-derived value APIs may return. */
    maskedKey: text("masked_key"),
    encryptedSigningSecret: bytea("encrypted_signing_secret"),
    signingSecretIv: bytea("signing_secret_iv"),
    signingSecretTag: bytea("signing_secret_tag"),
    status: agentStatusEnum("status").notNull().default("ready"),
    createdAt: createdAt(),
  },
  (table) => [index("agents_board_id_idx").on(table.boardId)],
);

// ---------------------------------------------------------------------------
// Invite links — sharing is one click
// ---------------------------------------------------------------------------

export const inviteLinks = pgTable(
  "invite_links",
  {
    token: text("token")
      .primaryKey()
      .$defaultFn(() => newId("invite")),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    role: inviteRoleEnum("role").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    /** Null = the link never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [index("invite_links_board_id_idx").on(table.boardId)],
);

// ---------------------------------------------------------------------------
// Yjs persistence — periodic snapshots + append-only update log
// ---------------------------------------------------------------------------

export const yjsSnapshots = pgTable(
  "yjs_snapshots",
  {
    id: serial("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    /** Monotonic per board — the latest seq is the doc to load. */
    seq: integer("seq").notNull(),
    snapshot: bytea("snapshot").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("yjs_snapshots_board_id_seq_idx").on(table.boardId, table.seq)],
);

export const yjsUpdates = pgTable(
  "yjs_updates",
  {
    id: serial("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    update: bytea("update").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("yjs_updates_board_id_idx").on(table.boardId)],
);

// ---------------------------------------------------------------------------
// Audit trail — append-only, never updated beyond resolution, NEVER deleted.
// No FKs on purpose: no cascade may ever reach these rows.
// ---------------------------------------------------------------------------

export const proposalsAudit = pgTable(
  "proposals_audit",
  {
    proposalId: text("proposal_id").primaryKey(),
    boardId: text("board_id").notNull(),
    kind: proposalKindEnum("kind").notNull(),
    /** usr_… or agt_… depending on authorKind — intentionally not an FK. */
    authorId: text("author_id").notNull(),
    authorKind: proposalAuthorKindEnum("author_kind").notNull(),
    payload: jsonb("payload").$type<ProposalPayload>().notNull(),
    status: proposalStatusEnum("status").notNull().default("open"),
    /** The engine's Resolution, written once by the ws server when it resolves. */
    resolution: jsonb("resolution"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [index("proposals_audit_board_id_idx").on(table.boardId)],
);

export const votesAudit = pgTable(
  "votes_audit",
  {
    id: serial("id").primaryKey(),
    proposalId: text("proposal_id").notNull(),
    /** mem_… board-member id from @quorum/shared/ids. */
    memberId: text("member_id").notNull(),
    value: voteValueEnum("value").notNull(),
    castAt: timestamp("cast_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("votes_audit_proposal_id_idx").on(table.proposalId)],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type BoardRow = typeof boards.$inferSelect;
export type NewBoardRow = typeof boards.$inferInsert;
export type BoardMemberRow = typeof boardMembers.$inferSelect;
export type NewBoardMemberRow = typeof boardMembers.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
export type InviteLinkRow = typeof inviteLinks.$inferSelect;
export type NewInviteLinkRow = typeof inviteLinks.$inferInsert;
export type YjsSnapshotRow = typeof yjsSnapshots.$inferSelect;
export type NewYjsSnapshotRow = typeof yjsSnapshots.$inferInsert;
export type YjsUpdateRow = typeof yjsUpdates.$inferSelect;
export type NewYjsUpdateRow = typeof yjsUpdates.$inferInsert;
export type ProposalAuditRow = typeof proposalsAudit.$inferSelect;
export type NewProposalAuditRow = typeof proposalsAudit.$inferInsert;
export type VoteAuditRow = typeof votesAudit.$inferSelect;
export type NewVoteAuditRow = typeof votesAudit.$inferInsert;
