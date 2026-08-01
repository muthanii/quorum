"use client";

/**
 * Owns the lifecycle of a board's Yjs connection: create on mount, destroy
 * on unmount, and expose connection status + sync state reactively via
 * useSyncExternalStore over the provider's events.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";

import { createBoardConnection, type BoardConnection, type BoardSelf } from "./provider";

export type BoardConnectionStatus = "connecting" | "connected" | "disconnected";

export interface BoardDocState {
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  awareness: Awareness | null;
  status: BoardConnectionStatus;
  /** True after the first full document sync with the ws server. */
  synced: boolean;
}

const PROVIDER_EVENTS = ["status", "connect", "disconnect", "synced", "close"] as const;

export function useBoardDoc(options: {
  boardId: string;
  wsUrl: string;
  self: BoardSelf;
}): BoardDocState {
  const { boardId, wsUrl } = options;
  const { id: selfId, name: selfName, role: selfRole, color: selfColor } = options.self;

  const [connection, setConnection] = useState<BoardConnection | null>(null);

  useEffect(() => {
    const next = createBoardConnection({
      boardId,
      wsUrl,
      self: { id: selfId, name: selfName, role: selfRole, color: selfColor },
    });
    setConnection(next);
    return () => {
      setConnection(null);
      next.destroy();
    };
  }, [boardId, wsUrl, selfId, selfName, selfRole, selfColor]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!connection) return () => {};
      for (const event of PROVIDER_EVENTS) connection.provider.on(event, onStoreChange);
      return () => {
        for (const event of PROVIDER_EVENTS) connection.provider.off(event, onStoreChange);
      };
    },
    [connection],
  );

  // Composite string snapshot: stable/comparable without allocating objects.
  const getSnapshot = useCallback(
    () =>
      connection
        ? `${connection.provider.status}|${connection.provider.isSynced ? "1" : "0"}`
        : "disconnected|0",
    [connection],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => "disconnected|0");
  const [rawStatus, rawSynced] = snapshot.split("|");
  const status: BoardConnectionStatus =
    rawStatus === "connected" || rawStatus === "connecting" ? rawStatus : "disconnected";

  return {
    doc: connection?.doc ?? null,
    provider: connection?.provider ?? null,
    awareness: connection?.awareness ?? null,
    status,
    synced: rawSynced === "1",
  };
}
