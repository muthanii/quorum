"use client";

/**
 * Live artifacts from the Y.Doc "artifacts" map, as validated plain-JSON
 * snapshots (malformed entries are skipped by the shared reader). Ordered
 * by creation time so the canvas renders deterministically everywhere.
 */
import { useMemo } from "react";
import type * as Y from "yjs";

import type { Artifact } from "@quorum/shared/schemas/artifact";
import { getArtifacts, readArtifact } from "@quorum/shared/yjs/doc";

import { useYSnapshot } from "./use-y-snapshot";

const EMPTY_ARTIFACTS: Artifact[] = [];

export function useArtifacts(doc: Y.Doc | null): Artifact[] {
  const map = useMemo(() => (doc ? getArtifacts(doc) : null), [doc]);

  return useYSnapshot(
    map,
    () => {
      if (!doc || !map) return EMPTY_ARTIFACTS;
      const artifacts: Artifact[] = [];
      map.forEach((_value, artifactId) => {
        const artifact = readArtifact(doc, artifactId);
        if (artifact) artifacts.push(artifact);
      });
      artifacts.sort((a, b) => a.meta.createdAt - b.meta.createdAt);
      return artifacts;
    },
    EMPTY_ARTIFACTS,
  );
}
