/**
 * Prefixed nanoid identifiers: `<prefix><nanoid(16)>`, e.g. `usr_V1StGXR8_Z5jdHi6`.
 * The prefix makes every id self-describing in logs, URLs, and audit rows.
 */
import { nanoid } from "nanoid";
import { z } from "zod";

export const ID_KINDS = [
  "user",
  "board",
  "member",
  "agent",
  "message",
  "proposal",
  "artifact",
  "vote",
  "turn",
  "invite",
] as const;

export type IdKind = (typeof ID_KINDS)[number];

export const PREFIXES = {
  user: "usr_",
  board: "brd_",
  member: "mem_",
  agent: "agt_",
  message: "msg_",
  proposal: "prp_",
  artifact: "art_",
  vote: "vte_",
  turn: "trn_",
  invite: "inv_",
} as const satisfies Record<IdKind, string>;

const ID_BODY_LENGTH = 16;

// nanoid's default url-safe alphabet: A-Za-z0-9_- (underscore in the body is
// fine — the prefix is fixed-width, so parsing never splits on "_").
const ID_PATTERNS: Record<IdKind, RegExp> = Object.fromEntries(
  ID_KINDS.map((kind) => [kind, new RegExp(`^${PREFIXES[kind]}[A-Za-z0-9_-]{${ID_BODY_LENGTH}}$`)]),
) as Record<IdKind, RegExp>;

export function newId(kind: IdKind): string {
  return `${PREFIXES[kind]}${nanoid(ID_BODY_LENGTH)}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && ID_PATTERNS[kind].test(value);
}

const ID_SCHEMAS: Record<IdKind, z.ZodString> = Object.fromEntries(
  ID_KINDS.map((kind) => [
    kind,
    z.string().regex(ID_PATTERNS[kind], `expected a ${kind} id ("${PREFIXES[kind]}" + 16 chars)`),
  ]),
) as Record<IdKind, z.ZodString>;

/** Zod schema for one id kind. Cached — safe to call in hot paths. */
export function idSchema(kind: IdKind): z.ZodString {
  return ID_SCHEMAS[kind];
}
