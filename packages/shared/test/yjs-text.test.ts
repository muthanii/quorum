import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { updateYText } from "../src/yjs/text";

interface SpliceStats {
  inserted: number;
  deleted: number;
  events: number;
}

/** True when the string contains no lone surrogate halves. */
function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Apply updateYText and report how much was actually inserted/deleted. */
function splice(initial: string, next: string): { result: string; stats: SpliceStats } {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  text.insert(0, initial);
  const stats: SpliceStats = { inserted: 0, deleted: 0, events: 0 };
  text.observe((event) => {
    stats.events++;
    for (const op of event.delta) {
      if (typeof op.insert === "string") stats.inserted += op.insert.length;
      if (typeof op.delete === "number") stats.deleted += op.delete;
    }
  });
  updateYText(text, next);
  return { result: text.toString(), stats };
}

describe("updateYText", () => {
  it("appends with a suffix-only insert", () => {
    const { result, stats } = splice("hello", "hello world");
    expect(result).toBe("hello world");
    expect(stats).toEqual({ inserted: 6, deleted: 0, events: 1 });
  });

  it("prepends with a prefix-only insert", () => {
    const { result, stats } = splice("world", "hello world");
    expect(result).toBe("hello world");
    expect(stats).toEqual({ inserted: 6, deleted: 0, events: 1 });
  });

  it("edits the middle with one minimal delete+insert", () => {
    const { result, stats } = splice("aaa XXX bbb", "aaa YY bbb");
    expect(result).toBe("aaa YY bbb");
    expect(stats.inserted).toBe(2);
    expect(stats.deleted).toBe(3);
    expect(stats.events).toBe(1);
  });

  it("inserts into the middle without deleting", () => {
    const { result, stats } = splice("hello world", "hello brave world");
    expect(result).toBe("hello brave world");
    expect(stats).toEqual({ inserted: 6, deleted: 0, events: 1 });
  });

  it("deletes from the middle without inserting", () => {
    const { result, stats } = splice("hello brave world", "hello world");
    expect(result).toBe("hello world");
    expect(stats.inserted).toBe(0);
    expect(stats.deleted).toBe(6);
  });

  it("does nothing when values are equal", () => {
    const { result, stats } = splice("same", "same");
    expect(result).toBe("same");
    expect(stats.events).toBe(0);
  });

  it("handles full replacement and emptying", () => {
    expect(splice("abc", "xyz").result).toBe("xyz");
    expect(splice("abc", "").result).toBe("");
    expect(splice("", "abc").result).toBe("abc");
  });

  it("never splits a surrogate pair at the prefix boundary", () => {
    // 👍 (👍) and 👎 (👎) share their high surrogate.
    const { result } = splice("hello 👍", "hello 👎");
    expect(result).toBe("hello 👎");
    expect(isWellFormedUtf16(result)).toBe(true);
  });

  it("never splits a surrogate pair at the suffix boundary", () => {
    const { result } = splice("a👍", "b👍");
    expect(result).toBe("b👍");
    expect(isWellFormedUtf16(result)).toBe(true);
  });

  it("handles emoji-only appends minimally", () => {
    const { result, stats } = splice("🎉🎉", "🎉🎉🎉");
    expect(result).toBe("🎉🎉🎉");
    expect(isWellFormedUtf16(result)).toBe(true);
    expect(stats.inserted).toBe(2); // one emoji = 2 UTF-16 code units
    expect(stats.deleted).toBe(0);
  });

  it("keeps unrelated concurrent edits when both sides converge", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("t").insert(0, "hello world");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // A rewrites the middle via updateYText; B appends at the end.
    updateYText(a.getText("t"), "hello brave world");
    b.getText("t").insert("hello world".length, "!");

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    expect(a.getText("t").toString()).toBe(b.getText("t").toString());
    // A full-rewrite would have dropped B's "!" — the minimal splice keeps it.
    expect(a.getText("t").toString()).toBe("hello brave world!");
  });
});
