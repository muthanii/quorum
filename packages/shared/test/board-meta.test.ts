import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { DEFAULT_POLICY, policySchema } from "../src/schemas/policy";
import { getBoardMeta, readBoardPolicy, setBoardPolicy } from "../src/yjs/board-meta";
import { DOC_KEYS } from "../src/yjs/keys";

describe("boardMeta doc key", () => {
  it("is registered in DOC_KEYS", () => {
    expect(DOC_KEYS.boardMeta).toBe("boardMeta");
  });

  it("readBoardPolicy returns null on a fresh doc (pre-boardMeta docs)", () => {
    const doc = new Y.Doc();
    expect(readBoardPolicy(doc)).toBeNull();
  });

  it("round-trips setBoardPolicy → readBoardPolicy", () => {
    const doc = new Y.Doc();
    setBoardPolicy(doc, DEFAULT_POLICY);
    expect(readBoardPolicy(doc)).toEqual(DEFAULT_POLICY);
  });

  it("mirrors a non-default policy exactly", () => {
    const doc = new Y.Doc();
    const policy = policySchema.parse({ rule: "threshold", thresholdN: 2, timeoutMs: 60_000 });
    setBoardPolicy(doc, policy);
    expect(readBoardPolicy(doc)).toEqual(policy);
  });

  it("overwriting replaces the previous mirror", () => {
    const doc = new Y.Doc();
    setBoardPolicy(doc, DEFAULT_POLICY);
    const next = policySchema.parse({ rule: "majority", vetoIsFinal: false });
    setBoardPolicy(doc, next);
    expect(readBoardPolicy(doc)).toEqual(next);
  });

  it("returns null when a hostile peer wrote garbage", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      getBoardMeta(doc).set("policy", { rule: "dictatorship" });
    });
    expect(readBoardPolicy(doc)).toBeNull();
  });

  it("rejects an invalid policy before mutating the doc", () => {
    const doc = new Y.Doc();
    expect(() =>
      setBoardPolicy(doc, { ...DEFAULT_POLICY, rule: "threshold", thresholdN: undefined }),
    ).toThrow();
    expect(readBoardPolicy(doc)).toBeNull();
  });

  it("converges across two docs syncing updates", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    setBoardPolicy(a, DEFAULT_POLICY);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readBoardPolicy(b)).toEqual(DEFAULT_POLICY);
  });
});
