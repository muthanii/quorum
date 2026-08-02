/**
 * Hocuspocus Database extension over Postgres: on load, hydrate the doc from
 * the latest snapshot + the raw update log; while live, append every
 * incremental update to yjs_updates (durable even if the process dies before
 * the next snapshot) and store debounced full snapshots (the debounce window
 * is the server-level `debounce`/`maxDebounce` configuration).
 *
 * Applying the full update log on top of the snapshot is deliberately
 * conservative: Yjs updates are commutative and idempotent, so re-applying
 * ones already contained in the snapshot is a no-op, and updates appended
 * after the snapshot was cut are never lost.
 *
 * Storing a snapshot also COMPACTS: the updates that snapshot subsumes are
 * deleted in the same transaction, so the log is bounded by what arrives
 * between two debounced snapshots rather than growing for the life of the
 * board. Compaction is deliberately conservative in the same direction as
 * replay — it prunes only what a snapshot provably contains, so the failure
 * mode is keeping a redundant row, never dropping a live one.
 */
import type {
  Extension,
  onChangePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import * as Y from "yjs";

import { serializeError, type Logger } from "./log";
import type { SnapshotStore } from "./stores";

export const PERSISTENCE_ORIGIN = "quorum:persistence";

export class PostgresPersistence implements Extension {
  extensionName = "quorum-postgres-persistence";

  constructor(
    private readonly snapshots: SnapshotStore,
    private readonly log: Logger,
  ) {}

  async onLoadDocument({ document, documentName }: onLoadDocumentPayload): Promise<Y.Doc> {
    const snapshot = await this.snapshots.loadLatestSnapshot(documentName);
    if (snapshot !== null) {
      Y.applyUpdate(document, snapshot.snapshot, PERSISTENCE_ORIGIN);
    }
    const updates = await this.snapshots.listUpdates(documentName);
    for (const update of updates) {
      try {
        Y.applyUpdate(document, update, PERSISTENCE_ORIGIN);
      } catch (error) {
        // One corrupt row must not take the whole board down.
        this.log.error("skipping corrupt yjs update row", {
          boardId: documentName,
          ...serializeError(error),
        });
      }
    }
    this.log.info("document loaded", {
      boardId: documentName,
      snapshotSeq: snapshot?.seq ?? null,
      replayedUpdates: updates.length,
    });
    return document;
  }

  async onChange({ documentName, update }: onChangePayload): Promise<void> {
    try {
      await this.snapshots.appendUpdate(documentName, update);
    } catch (error) {
      // Hocuspocus turns a rejected onChange into an unhandled rejection —
      // log loudly instead; the debounced snapshot still captures the state.
      this.log.error("failed to append yjs update", {
        boardId: documentName,
        ...serializeError(error),
      });
    }
  }

  async onStoreDocument({ document, documentName }: onStoreDocumentPayload): Promise<void> {
    try {
      // Read the high-water mark BEFORE encoding. Hocuspocus applies an update
      // to the document before onChange writes it, so every row at or below
      // this id is already inside the state encoded next. Rows appended while
      // we encode land above the mark and are kept — replaying an update the
      // snapshot already contains is a no-op, losing one is not.
      const compactThrough = await this.snapshots.latestUpdateId(documentName);
      const state = Y.encodeStateAsUpdate(document);
      const { prunedUpdates, prunedSnapshots } = await this.snapshots.storeSnapshot(
        documentName,
        state,
        compactThrough,
      );
      this.log.debug("snapshot stored", {
        boardId: documentName,
        bytes: state.byteLength,
        compactThrough,
        prunedUpdates,
        prunedSnapshots,
      });
    } catch (error) {
      this.log.error("failed to store yjs snapshot", {
        boardId: documentName,
        ...serializeError(error),
      });
    }
  }
}
