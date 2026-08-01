"use client";

/**
 * The board's consensus policy mirrored live into the doc's "boardMeta" key by
 * the ws server (brief addendum #1). Null for docs from before the key existed
 * or when the mirror is malformed — callers fall back to the REST value.
 */
import { useMemo } from "react";
import type * as Y from "yjs";

import type { ConsensusPolicy } from "@quorum/shared/schemas/policy";
import { getBoardMeta, readBoardPolicy } from "@quorum/shared/yjs/board-meta";

import { useYSnapshot } from "./use-y-snapshot";

export function useBoardPolicy(doc: Y.Doc | null): ConsensusPolicy | null {
  const map = useMemo(() => (doc ? getBoardMeta(doc) : null), [doc]);

  return useYSnapshot(map, () => (doc ? readBoardPolicy(doc) : null), null);
}
