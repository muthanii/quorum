/** Smoke tests: the schema exports the tables/enums the rest of the stack builds against. */
import { getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { AGENT_KINDS, AGENT_STATUSES } from "@quorum/shared/schemas/agent";
import { MEMBER_ROLES } from "@quorum/shared/schemas/member";
import { PROPOSAL_KINDS, PROPOSAL_STATUSES } from "@quorum/shared/schemas/proposal";
import { VOTE_VALUES } from "@quorum/shared/schemas/vote";

import * as schema from "../src/schema";

describe("tables", () => {
  const expected: Array<[PgTable, string]> = [
    [schema.users, "users"],
    [schema.accounts, "accounts"],
    [schema.sessions, "sessions"],
    [schema.verificationTokens, "verification_tokens"],
    [schema.boards, "boards"],
    [schema.boardMembers, "board_members"],
    [schema.agents, "agents"],
    [schema.inviteLinks, "invite_links"],
    [schema.yjsSnapshots, "yjs_snapshots"],
    [schema.yjsUpdates, "yjs_updates"],
    [schema.proposalsAudit, "proposals_audit"],
    [schema.votesAudit, "votes_audit"],
  ];

  it.each(expected.map(([table, name]) => [name, table] as const))("exports %s", (name, table) => {
    expect(getTableName(table)).toBe(name);
  });

  it("board_members has a composite (boardId, userId) primary key", () => {
    const config = getTableConfig(schema.boardMembers);
    const pk = config.primaryKeys[0];
    expect(pk).toBeDefined();
    expect(pk!.columns.map((c) => c.name).sort()).toEqual(["board_id", "user_id"]);
  });

  it("indexes every boardId column", () => {
    for (const table of [
      schema.agents,
      schema.inviteLinks,
      schema.yjsUpdates,
      schema.proposalsAudit,
    ]) {
      const config = getTableConfig(table);
      const indexed = config.indexes.some((idx) =>
        idx.config.columns.some((col) => "name" in col && col.name === "board_id"),
      );
      expect(indexed, `${getTableName(table)} must index board_id`).toBe(true);
    }
    // yjs_snapshots covers board_id via its unique (board_id, seq) index.
    const snapshots = getTableConfig(schema.yjsSnapshots);
    expect(
      snapshots.indexes.some(
        (idx) =>
          idx.config.unique &&
          idx.config.columns.some((col) => "name" in col && col.name === "board_id"),
      ),
    ).toBe(true);
  });

  it("stores agent credentials only as bytea ciphertext + iv + tag and a masked suffix", () => {
    const columns = getTableConfig(schema.agents).columns;
    const byName = new Map(columns.map((c) => [c.name, c]));
    for (const name of [
      "encrypted_credential",
      "credential_iv",
      "credential_tag",
      "encrypted_signing_secret",
      "signing_secret_iv",
      "signing_secret_tag",
    ]) {
      expect(byName.get(name)?.getSQLType(), `agents.${name}`).toBe("bytea");
    }
    expect(byName.get("masked_key")?.getSQLType()).toBe("text");
    // No plaintext credential column exists.
    expect([...byName.keys()].some((name) => /^(api_key|credential|secret)$/.test(name))).toBe(
      false,
    );
  });
});

describe("enums", () => {
  it("reuses the shared domain vocabulary", () => {
    expect(schema.memberRoleEnum.enumValues).toEqual([...MEMBER_ROLES]);
    expect(schema.agentKindEnum.enumValues).toEqual([...AGENT_KINDS]);
    expect(schema.agentStatusEnum.enumValues).toEqual([...AGENT_STATUSES]);
    expect(schema.proposalKindEnum.enumValues).toEqual([...PROPOSAL_KINDS]);
    expect(schema.proposalStatusEnum.enumValues).toEqual([...PROPOSAL_STATUSES]);
    expect(schema.voteValueEnum.enumValues).toEqual([...VOTE_VALUES]);
    expect(schema.proposalAuthorKindEnum.enumValues).toEqual(["human", "agent"]);
    expect(schema.inviteRoleEnum.enumValues).toEqual(["editor", "viewer"]);
  });
});
