import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { readArtifact } from "@quorum/shared/yjs/doc";

import {
  createHumanArtifact,
  getArtifactTableBody,
  getArtifactTextBody,
  moveArtifact,
  setTableCell,
} from "./artifact-write";

describe("createHumanArtifact", () => {
  it("creates a valid doc artifact with an empty text body", () => {
    const doc = new Y.Doc();
    const id = createHumanArtifact(doc, "doc");
    const artifact = readArtifact(doc, id);
    expect(artifact).not.toBeNull();
    expect(artifact?.meta.type).toBe("doc");
    expect(artifact?.meta.title).toBe("Untitled doc");
    expect(artifact?.body).toBe("");
    expect(artifact?.meta.authorAgentId).toBeUndefined();
  });

  it("creates a valid table artifact with default cols and empty rows", () => {
    const doc = new Y.Doc();
    const id = createHumanArtifact(doc, "table");
    const artifact = readArtifact(doc, id);
    expect(artifact?.meta.type).toBe("table");
    expect(artifact?.body).toEqual({
      cols: ["Column A", "Column B", "Column C"],
      rows: [
        { "Column A": "", "Column B": "", "Column C": "" },
        { "Column A": "", "Column B": "", "Column C": "" },
        { "Column A": "", "Column B": "", "Column C": "" },
      ],
    });
  });

  it("cascades positions so stacked creations do not overlap", () => {
    const doc = new Y.Doc();
    const first = readArtifact(doc, createHumanArtifact(doc, "doc"));
    const second = readArtifact(doc, createHumanArtifact(doc, "doc"));
    expect(second?.meta.x).toBe((first?.meta.x ?? 0) + 48);
    expect(second?.meta.y).toBe((first?.meta.y ?? 0) + 48);
  });
});

describe("moveArtifact", () => {
  it("writes the new position into meta", () => {
    const doc = new Y.Doc();
    const id = createHumanArtifact(doc, "doc");
    expect(moveArtifact(doc, id, 300, -40)).toBe(true);
    const artifact = readArtifact(doc, id);
    expect(artifact?.meta.x).toBe(300);
    expect(artifact?.meta.y).toBe(-40);
  });

  it("returns false for a missing artifact", () => {
    const doc = new Y.Doc();
    expect(moveArtifact(doc, "art_missing00000001", 0, 0)).toBe(false);
  });
});

describe("body accessors", () => {
  it("returns the Y.Text body for docs and null for tables", () => {
    const doc = new Y.Doc();
    const docId = createHumanArtifact(doc, "doc");
    const tableId = createHumanArtifact(doc, "table");
    expect(getArtifactTextBody(doc, docId)).toBeInstanceOf(Y.Text);
    expect(getArtifactTextBody(doc, tableId)).toBeNull();
    expect(getArtifactTableBody(doc, tableId)).toBeInstanceOf(Y.Map);
    expect(getArtifactTableBody(doc, docId)).toBeNull();
  });
});

describe("setTableCell", () => {
  it("updates a single cell", () => {
    const doc = new Y.Doc();
    const id = createHumanArtifact(doc, "table");
    expect(setTableCell(doc, id, 1, "Column B", "42")).toBe(true);
    const artifact = readArtifact(doc, id);
    const body = artifact?.body as { rows: Record<string, string>[] };
    expect(body.rows[1]?.["Column B"]).toBe("42");
    expect(body.rows[0]?.["Column B"]).toBe("");
  });

  it("rejects out-of-range rows and missing artifacts", () => {
    const doc = new Y.Doc();
    const id = createHumanArtifact(doc, "table");
    expect(setTableCell(doc, id, 99, "Column A", "x")).toBe(false);
    expect(setTableCell(doc, id, -1, "Column A", "x")).toBe(false);
    expect(setTableCell(doc, "art_missing00000001", 0, "Column A", "x")).toBe(false);
  });
});
