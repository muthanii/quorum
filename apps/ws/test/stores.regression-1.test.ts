/**
 * Regression: compaction reported "prunedUpdates: 0" on every write while
 * actually deleting rows, because postgres-js returns an Array SUBCLASS whose
 * `.length` is 0 without a RETURNING clause and whose real figure sits on
 * `.count`. An Array.isArray branch that ran first swallowed it, so the log
 * said nothing was ever pruned.
 * Found by /devex-review follow-up on 2026-08-02 by reading live ws output
 * against the actual row counts in Postgres.
 */
import { describe, expect, it } from "vitest";

import { rowsAffected } from "../src/stores";

/** postgres-js: an Array subclass carrying `count`, with no rows in it. */
class PostgresJsResult extends Array {
  count: number;
  constructor(count: number) {
    super();
    this.count = count;
  }
}

describe("rowsAffected", () => {
  it("reads count off a postgres-js result even though it is an empty array", () => {
    expect(rowsAffected(new PostgresJsResult(7))).toBe(7);
  });

  it("still reports zero when a postgres-js delete matched nothing", () => {
    expect(rowsAffected(new PostgresJsResult(0))).toBe(0);
  });

  it("reads rowCount from a node-postgres style result", () => {
    expect(rowsAffected({ rowCount: 4 })).toBe(4);
  });

  it("falls back to array length for drivers that return the deleted rows", () => {
    expect(rowsAffected([{ id: 1 }, { id: 2 }])).toBe(2);
  });

  it.each([null, undefined, 0, "3", {}])("returns 0 for the unusable result %j", (value) => {
    expect(rowsAffected(value)).toBe(0);
  });
});
