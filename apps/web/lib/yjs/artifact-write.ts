/**
 * Client-side write/read helpers for HUMAN edits to canvas artifacts. Humans
 * editing artifact bodies or dragging cards is collaborative editing —
 * CRDT-merged, never a Proposal (CLAUDE.md §6). Everything goes through the
 * shared typed accessors; no raw doc keys are touched here.
 */
import * as Y from "yjs";

import { newId } from "@quorum/shared/ids";
import type { ArtifactType, TableBody } from "@quorum/shared/schemas/artifact";
import { cascadePosition, createArtifactInDoc, getArtifacts } from "@quorum/shared/yjs/doc";

const DEFAULT_SIZE: Record<ArtifactType, { w: number; h: number }> = {
  doc: { w: 480, h: 400 },
  table: { w: 560, h: 320 },
};

const DEFAULT_TITLE: Record<ArtifactType, string> = {
  doc: "Untitled doc",
  table: "Untitled table",
};

function defaultTableBody(): TableBody {
  const cols = ["Column A", "Column B", "Column C"];
  const emptyRow = () => Object.fromEntries(cols.map((col) => [col, ""]));
  return { cols, rows: [emptyRow(), emptyRow(), emptyRow()] };
}

/**
 * Create a blank human-authored artifact (palette / empty state). Direct doc
 * write — humans creating artifacts never need a proposal. Returns the id.
 */
export function createHumanArtifact(doc: Y.Doc, type: ArtifactType): string {
  const id = newId("artifact");
  const count = getArtifacts(doc).size;
  const size = DEFAULT_SIZE[type];
  createArtifactInDoc(doc, {
    id,
    meta: {
      type,
      title: DEFAULT_TITLE[type],
      ...cascadePosition(count),
      w: size.w,
      h: size.h,
      createdAt: Date.now(),
    },
    body: type === "doc" ? "" : defaultTableBody(),
  });
  return id;
}

function getArtifactMap(doc: Y.Doc, artifactId: string): Y.Map<unknown> | null {
  const artifact = getArtifacts(doc).get(artifactId);
  return artifact instanceof Y.Map ? artifact : null;
}

/** Drag-to-move: write the card's canvas position into the artifact meta. */
export function moveArtifact(doc: Y.Doc, artifactId: string, x: number, y: number): boolean {
  const meta = getArtifactMap(doc, artifactId)?.get("meta");
  if (!(meta instanceof Y.Map)) return false;
  doc.transact(() => {
    meta.set("x", x);
    meta.set("y", y);
  });
  return true;
}

/** The live Y.Text body of a "doc" artifact (bind via useYText), or null. */
export function getArtifactTextBody(doc: Y.Doc, artifactId: string): Y.Text | null {
  const body = getArtifactMap(doc, artifactId)?.get("body");
  return body instanceof Y.Text ? body : null;
}

/** The live {cols, rows} Y.Map body of a "table" artifact, or null. */
export function getArtifactTableBody(doc: Y.Doc, artifactId: string): Y.Map<unknown> | null {
  const body = getArtifactMap(doc, artifactId)?.get("body");
  return body instanceof Y.Map ? body : null;
}

/**
 * Set one table cell. Writes only that row's key, so concurrent edits to
 * different cells merge; same-cell conflicts resolve last-writer-wins.
 */
export function setTableCell(
  doc: Y.Doc,
  artifactId: string,
  rowIndex: number,
  col: string,
  value: string,
): boolean {
  const body = getArtifactTableBody(doc, artifactId);
  const rows = body?.get("rows");
  if (!(rows instanceof Y.Array)) return false;
  if (rowIndex < 0 || rowIndex >= rows.length) return false;
  const row: unknown = rows.get(rowIndex);
  if (!(row instanceof Y.Map)) return false;
  doc.transact(() => {
    row.set(col, value);
  });
  return true;
}
