"use client";

/**
 * A "doc" artifact body: a textarea bound to the artifact's Y.Text through
 * useYText. Humans edit directly — this is collaborative editing, CRDT-merged
 * character by character, never a proposal (CLAUDE.md §6). Agent edits arrive
 * separately as artifact.patch proposals.
 */
import { useMemo } from "react";
import type * as Y from "yjs";

import { getArtifactTextBody } from "@/lib/yjs/artifact-write";
import { useYText } from "@/lib/yjs/use-y-text";

export interface DocArtifactBodyProps {
  doc: Y.Doc;
  artifactId: string;
  title: string;
  canEdit: boolean;
}

export function DocArtifactBody({ doc, artifactId, title, canEdit }: DocArtifactBodyProps) {
  const text = useMemo(() => getArtifactTextBody(doc, artifactId), [doc, artifactId]);
  const { value, setValue } = useYText(text);

  return (
    <textarea
      className="size-full resize-none bg-transparent p-3 text-ui text-foreground outline-none select-text placeholder:text-faint"
      value={value}
      readOnly={!canEdit}
      onChange={(event) => setValue(event.target.value)}
      placeholder={canEdit ? "Start writing — everyone sees it live." : ""}
      aria-label={`Document “${title}” content${canEdit ? "" : " (read-only)"}`}
    />
  );
}
