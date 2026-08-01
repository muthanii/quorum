/**
 * Typed accessors for the "boardMeta" doc key — a ws-maintained live mirror
 * of the board's consensus policy so the policy badge updates in real time.
 *
 * The policy of record lives in Postgres (boards.consensusPolicy). The ws
 * server mirrors it here on doc load and when a policy_change proposal is
 * applied. Clients only read; a hostile peer scribbling over the key cannot
 * crash anyone (readers zod-validate) and cannot change the authoritative
 * policy (the ws server never reads it back from the doc).
 */
import * as Y from "yjs";

import { policySchema, type ConsensusPolicy } from "../schemas/policy";
import { DOC_KEYS } from "./keys";

export function getBoardMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(DOC_KEYS.boardMeta);
}

/** ws-only: mirror the authoritative policy into the doc. Validates first. */
export function setBoardPolicy(doc: Y.Doc, policy: ConsensusPolicy): ConsensusPolicy {
  const parsed = policySchema.parse(policy);
  doc.transact(() => {
    getBoardMeta(doc).set("policy", structuredClone(parsed));
  });
  return parsed;
}

/**
 * Read the mirrored policy. Returns null when the key is absent (docs created
 * before boardMeta existed) or malformed — callers fall back to the REST
 * value.
 */
export function readBoardPolicy(doc: Y.Doc): ConsensusPolicy | null {
  const raw: unknown = getBoardMeta(doc).get("policy");
  const json = raw instanceof Y.AbstractType ? raw.toJSON() : raw;
  const parsed = policySchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
