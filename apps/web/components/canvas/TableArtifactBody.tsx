"use client";

/**
 * A "table" artifact body: column headers + editable cells bound to the
 * artifact's {cols, rows} Y structure. Cell edits are direct human writes
 * (CRDT-merged, one row-key per write — see setTableCell), never proposals.
 */
import { useMemo } from "react";
import type * as Y from "yjs";

import { tableBodySchema, type TableBody } from "@quorum/shared/schemas/artifact";

import { getArtifactTableBody, setTableCell } from "@/lib/yjs/artifact-write";
import { useYSnapshot } from "@/lib/yjs/use-y-snapshot";

export interface TableArtifactBodyProps {
  doc: Y.Doc;
  artifactId: string;
  title: string;
  canEdit: boolean;
}

export function TableArtifactBody({ doc, artifactId, title, canEdit }: TableArtifactBodyProps) {
  const body = useMemo(() => getArtifactTableBody(doc, artifactId), [doc, artifactId]);

  const table = useYSnapshot<TableBody | null>(
    body,
    () => {
      if (!body) return null;
      const parsed = tableBodySchema.safeParse(body.toJSON());
      return parsed.success ? parsed.data : null;
    },
    null,
  );

  if (!table) {
    return <p className="p-3 text-xs text-faint">This table could not be read.</p>;
  }

  return (
    <div className="size-full overflow-auto">
      <table className="w-full border-collapse text-ui" aria-label={`Table “${title}”`}>
        <thead>
          <tr>
            {table.cols.map((col) => (
              <th
                key={col}
                scope="col"
                className="sticky top-0 border-b bg-surface px-2 py-1.5 text-left text-[11px] font-medium text-muted"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            // Rows have no stable identity of their own; index is the row key.
            <tr key={rowIndex}>
              {table.cols.map((col) => (
                <td key={col} className="border-b border-border/60 p-0 align-top">
                  <input
                    value={row[col] ?? ""}
                    readOnly={!canEdit}
                    onChange={(event) =>
                      setTableCell(doc, artifactId, rowIndex, col, event.target.value)
                    }
                    className="w-full min-w-24 bg-transparent px-2 py-1.5 text-ui outline-none select-text focus-visible:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    aria-label={`${col}, row ${rowIndex + 1}`}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
