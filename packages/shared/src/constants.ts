/** Shared timing/window constants. Web, ws, and worker must agree on these. */

/**
 * "Active" quorum window: a member counts toward consensus when connected now
 * OR seen within the last 5 minutes (CLAUDE.md §6).
 */
export const ACTIVE_WINDOW_MS = 300_000;

/** How many trailing chat messages a turn payload's context carries. */
export const CHAT_CONTEXT_TAIL = 50;

/**
 * Grace period after a disconnect before a member leaves the active quorum —
 * the UI shows the recalculation instead of silently changing the threshold.
 */
export const PRESENCE_GRACE_MS = 30_000;
