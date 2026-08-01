/**
 * Server-side authorization for client writes into the proposals map.
 *
 * Hocuspocus applies every client update with the originating Connection as
 * the transaction origin, and a Connection carries the context returned by
 * onAuthenticate. That is the only trustworthy identity in the pipeline: the
 * vote keys, author ids, and statuses inside the doc are just CRDT data that
 * any writable peer can set to anything.
 *
 * Without this guard one editor can write approvals in every other member's
 * name and drive a proposal to "approved" alone — the exact failure the
 * product exists to prevent (CLAUDE.md §1.3, §6). The consensus controller is
 * authoritative about the RESOLUTION; this module is authoritative about who
 * may write which vote in the first place.
 *
 * Policy enforced here, on every non-server transaction:
 *   - a client may add/update/delete ONLY its own key in a proposal's votes map
 *   - the immutable fields of an existing proposal may not be edited at all
 * Violations are reverted in the same tick, before the consensus controller
 * evaluates, so a forged vote is never tallied and never audited.
 */
import type * as Y from "yjs";

import { memberIdForUser } from "./auth";
import type { Logger } from "./log";

/** Transaction origin for guard reverts — the observer ignores it. */
export const GUARD_ORIGIN = "quorum:doc-guard";

/**
 * Proposal fields the server owns once a proposal exists. `votes` is handled
 * separately (own-key writes are legitimate); everything else is set at
 * creation and thereafter only by the consensus controller.
 */
const SERVER_OWNED_FIELDS = new Set([
  "id",
  "kind",
  "authorId",
  "authorKind",
  "createdAt",
  "expiresAt",
  "status",
  "payload",
  "affectedArtifactIds",
]);

/**
 * The identity behind a transaction, or null when the write did not come from
 * a client connection (server transactions, persistence load — both trusted).
 */
function writerUserId(origin: unknown): string | null {
  if (typeof origin !== "object" || origin === null) return null;
  const context = (origin as { context?: unknown }).context;
  if (typeof context !== "object" || context === null) return null;
  const userId = (context as { userId?: unknown }).userId;
  return typeof userId === "string" && userId !== "" ? userId : null;
}

/** True when `key` is the writer's own vote key in either id space. */
function ownsVoteKey(key: string, userId: string): boolean {
  return key === userId || key === memberIdForUser(userId);
}

interface GuardResult {
  /** Number of unauthorized changes reverted. */
  reverted: number;
}

/**
 * Inspect one transaction's events and undo anything the writer was not
 * allowed to do. Safe to call for every transaction: server-origin writes and
 * reverts are skipped without touching the doc.
 */
export function enforceProposalWrites(
  doc: Y.Doc,
  events: Y.YEvent<Y.AbstractType<unknown>>[],
  transaction: Y.Transaction,
  log: Logger,
  boardId: string,
): GuardResult {
  const userId = writerUserId(transaction.origin);
  if (userId === null) return { reverted: 0 };

  // Collected first, applied in one transaction — mutating mid-iteration would
  // re-enter the observer while its own event list is still being walked.
  const undo: Array<() => void> = [];

  for (const event of events) {
    const path = event.path;
    const target = event.target as Y.Map<unknown>;

    // proposals.<id>.votes — one entry per member, own key only.
    if (path.length === 2 && path[1] === "votes") {
      for (const [key, change] of event.changes.keys) {
        if (ownsVoteKey(key, userId)) continue;
        if (change.action === "add") {
          undo.push(() => target.delete(key));
        } else {
          // update or delete — put the previous entry back verbatim.
          const previous = change.oldValue as unknown;
          undo.push(() => target.set(key, previous));
        }
      }
      continue;
    }

    // proposals.<id> — server-owned fields are immutable to clients. A brand
    // new proposal arrives as a single "add" on the proposals map itself
    // (path.length === 0), which stays allowed: staging is a client action.
    if (path.length === 1) {
      for (const [key, change] of event.changes.keys) {
        if (!SERVER_OWNED_FIELDS.has(key)) continue;
        if (change.action === "add") {
          undo.push(() => target.delete(key));
        } else {
          const previous = change.oldValue as unknown;
          undo.push(() => target.set(key, previous));
        }
      }
    }
  }

  if (undo.length === 0) return { reverted: 0 };

  doc.transact(() => {
    for (const revert of undo) revert();
  }, GUARD_ORIGIN);

  log.warn("reverted unauthorized proposal write", {
    boardId,
    userId,
    reverted: undo.length,
  });
  return { reverted: undo.length };
}
