/**
 * Pure "active quorum" computation (CLAUDE.md §6): a member counts toward
 * consensus when connected now OR seen within the active window. Viewers are
 * never part of the voting quorum. The caller injects `now` and presence —
 * this module reads no clocks and does no I/O.
 */
import { ACTIVE_WINDOW_MS } from "../constants";
import type { MemberRole } from "../schemas/member";

export interface QuorumMember {
  id: string;
  role: MemberRole;
  /** Unix epoch milliseconds of last activity. */
  lastSeenAt: number;
}

export interface ActiveMemberIdsInput {
  members: readonly QuorumMember[];
  /** Member ids with a live connection right now (e.g. from awareness). */
  connectedIds: Iterable<string>;
  /** Unix epoch milliseconds — injected, never Date.now() in here. */
  now: number;
  /** Defaults to ACTIVE_WINDOW_MS (5 minutes). */
  activeWindowMs?: number;
}

export function activeMemberIds(input: ActiveMemberIdsInput): string[] {
  const windowMs = input.activeWindowMs ?? ACTIVE_WINDOW_MS;
  const connected = new Set(input.connectedIds);
  const cutoff = input.now - windowMs;
  const seen = new Set<string>();
  const active: string[] = [];
  for (const member of input.members) {
    if (member.role === "viewer") continue;
    if (seen.has(member.id)) continue;
    if (connected.has(member.id) || member.lastSeenAt >= cutoff) {
      seen.add(member.id);
      active.push(member.id);
    }
  }
  return active;
}
