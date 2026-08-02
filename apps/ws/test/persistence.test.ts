/**
 * Yjs persistence: replay correctness and update-log compaction.
 *
 * Compaction is the risky half — deleting history that a snapshot does not
 * actually contain loses board state permanently, and Yjs will not tell you.
 * These tests pin the ordering rule that makes it safe.
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { PostgresPersistence } from "../src/persistence";
import type { Logger } from "../src/log";
import type { SnapshotStore, SnapshotWriteResult } from "../src/stores";

const BOARD = "brd_compaction_test";

function silentLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

interface UpdateRow {
  id: number;
  update: Uint8Array;
}

/**
 * In-memory SnapshotStore with the same semantics as the Postgres one:
 * monotonic update ids, monotonic snapshot seqs, and a compacting write that
 * deletes only rows at or below the mark it is given.
 */
function memoryStore() {
  let nextUpdateId = 0;
  let nextSeq = 0;
  const updates: UpdateRow[] = [];
  const snapshots: { seq: number; snapshot: Uint8Array }[] = [];
  /** Runs between latestUpdateId() and storeSnapshot(), simulating concurrency. */
  let duringEncode: (() => void) | null = null;

  const store: SnapshotStore = {
    async loadLatestSnapshot() {
      const latest = snapshots.at(-1);
      return latest === undefined ? null : { seq: latest.seq, snapshot: latest.snapshot };
    },
    async listUpdates() {
      return updates.map((row) => row.update);
    },
    async appendUpdate(_boardId, update) {
      nextUpdateId += 1;
      updates.push({ id: nextUpdateId, update });
    },
    async latestUpdateId() {
      const mark = updates.at(-1)?.id ?? null;
      duringEncode?.();
      duringEncode = null;
      return mark;
    },
    async storeSnapshot(_boardId, snapshot, compactThrough): Promise<SnapshotWriteResult> {
      nextSeq += 1;
      snapshots.push({ seq: nextSeq, snapshot });

      let prunedUpdates = 0;
      if (compactThrough !== null) {
        const keep = updates.filter((row) => row.id > compactThrough);
        prunedUpdates = updates.length - keep.length;
        updates.splice(0, updates.length, ...keep);
      }

      const cutoff = nextSeq - 3;
      const keptSnapshots = snapshots.filter((row) => row.seq > cutoff);
      const prunedSnapshots = snapshots.length - keptSnapshots.length;
      snapshots.splice(0, snapshots.length, ...keptSnapshots);

      return { prunedUpdates, prunedSnapshots };
    },
  };

  return {
    store,
    updates,
    snapshots,
    /** Schedule a write that lands after the mark is read but before the snapshot. */
    onEncode(fn: () => void) {
      duringEncode = fn;
    },
  };
}

/** A doc with `text` typed into it, plus the update that produced it. */
function docWith(text: string): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  return { doc, update: Y.encodeStateAsUpdate(doc) };
}

describe("PostgresPersistence compaction", () => {
  it("prunes the updates a snapshot already contains", async () => {
    const mem = memoryStore();
    const persistence = new PostgresPersistence(mem.store, silentLogger());
    const { doc, update } = docWith("hello");

    await persistence.onChange({ documentName: BOARD, update } as never);
    expect(mem.updates).toHaveLength(1);

    await persistence.onStoreDocument({ document: doc, documentName: BOARD } as never);

    expect(mem.updates).toHaveLength(0);
    expect(mem.snapshots).toHaveLength(1);
  });

  it("keeps an update that arrives after the mark is taken", async () => {
    const mem = memoryStore();
    const persistence = new PostgresPersistence(mem.store, silentLogger());
    const { doc, update } = docWith("hello");
    await persistence.onChange({ documentName: BOARD, update } as never);

    // A collaborator types while the snapshot is being encoded. That row is
    // NOT in the snapshot, so pruning it would lose their edit.
    const late = docWith("late edit").update;
    mem.onEncode(() => {
      void mem.store.appendUpdate(BOARD, late);
    });

    await persistence.onStoreDocument({ document: doc, documentName: BOARD } as never);

    expect(mem.updates).toHaveLength(1);
    expect(mem.updates[0]?.update).toBe(late);
  });

  it("survives a round trip: state after compaction equals state before", async () => {
    const mem = memoryStore();
    const persistence = new PostgresPersistence(mem.store, silentLogger());

    const doc = new Y.Doc();
    doc.getText("body").insert(0, "first");
    await persistence.onChange({
      documentName: BOARD,
      update: Y.encodeStateAsUpdate(doc),
    } as never);
    await persistence.onStoreDocument({ document: doc, documentName: BOARD } as never);

    // An edit after the snapshot — this one lives only in the update log.
    doc.getText("body").insert(5, " and second");
    await persistence.onChange({
      documentName: BOARD,
      update: Y.encodeStateAsUpdate(doc),
    } as never);

    const reloaded = await persistence.onLoadDocument({
      document: new Y.Doc(),
      documentName: BOARD,
    } as never);

    expect(reloaded.getText("body").toString()).toBe("first and second");
  });

  it("keeps the newest snapshots and drops the rest", async () => {
    const mem = memoryStore();
    const persistence = new PostgresPersistence(mem.store, silentLogger());
    const { doc } = docWith("x");

    for (let i = 0; i < 8; i += 1) {
      await persistence.onStoreDocument({ document: doc, documentName: BOARD } as never);
    }

    expect(mem.snapshots).toHaveLength(3);
    expect(mem.snapshots.at(-1)?.seq).toBe(8);
  });

  it("writes the snapshot but prunes nothing when the log is empty", async () => {
    const mem = memoryStore();
    const persistence = new PostgresPersistence(mem.store, silentLogger());
    const { doc } = docWith("x");

    await persistence.onStoreDocument({ document: doc, documentName: BOARD } as never);

    expect(mem.snapshots).toHaveLength(1);
    expect(mem.updates).toHaveLength(0);
  });

  it("leaves the log intact when the snapshot write fails", async () => {
    const mem = memoryStore();
    const failing: SnapshotStore = {
      ...mem.store,
      async storeSnapshot() {
        throw new Error("postgres is down");
      },
    };
    const persistence = new PostgresPersistence(failing, silentLogger());
    const { doc, update } = docWith("hello");
    await persistence.onChange({ documentName: BOARD, update } as never);

    // Must not throw — a failed snapshot cannot take the board down.
    await persistence.onStoreDocument({ document: doc, documentName: BOARD } as never);

    expect(mem.updates).toHaveLength(1);
  });
});
