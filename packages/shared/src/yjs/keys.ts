/**
 * The Y.Doc's top-level keys. Clients and the ws server both go through the
 * typed accessors in ./doc — never touch these keys ad hoc, so the doc shape
 * stays migratable.
 */
export const DOC_KEYS = {
  /** Y.Array<Y.Map> — append-only group chat. */
  chat: "chat",
  /** Y.Map<artifactId, Y.Map{meta, body}>. */
  artifacts: "artifacts",
  /** Y.Map<proposalId, Y.Map> — open proposals + live vote tallies. */
  proposals: "proposals",
  /** Y.Map<agentId, {status, at}> — live roster pills, maintained by ws. */
  agentStatus: "agentStatus",
  /**
   * Y.Map holding { policy: ConsensusPolicy } — a live mirror of the board's
   * consensus policy, written ONLY by the ws server (on doc load and when a
   * policy_change proposal applies). Policy of record is Postgres
   * (boards.consensusPolicy); old docs without this key read as null and
   * clients fall back to the REST value.
   */
  boardMeta: "boardMeta",
} as const;

export type DocKey = (typeof DOC_KEYS)[keyof typeof DOC_KEYS];

/**
 * Ephemeral per-peer state broadcast via y-protocols awareness. Never
 * persisted; never contains secrets.
 */
export interface AwarenessState {
  userId: string;
  name: string;
  /** Identity color from MEMBER_PALETTE (colorForUser). */
  color: string;
  /** Canvas-space pointer position; null when the pointer left the canvas. */
  cursor: { x: number; y: number } | null;
  /** Selected artifact ids — rendered as halos in this user's color. */
  selection: string[];
  isTyping: boolean;
}
