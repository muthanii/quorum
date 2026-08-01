"use client";

/**
 * Ephemeral presence over y-protocols awareness: who else is here, their
 * cursors/selections/typing state, and setters for the local peer. Cursor
 * broadcasts are throttled (~30ms trailing edge) so pointer moves never
 * flood the wire; the last position always wins.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Awareness } from "y-protocols/awareness";

import type { AwarenessState } from "@quorum/shared/yjs/keys";

const CURSOR_THROTTLE_MS = 30;

export interface AwarenessPeer {
  clientId: number;
  state: AwarenessState;
}

export interface UseAwarenessResult {
  /** Remote peers only (local client excluded), sorted by clientId. */
  peers: AwarenessPeer[];
  setCursor: (cursor: { x: number; y: number } | null) => void;
  setSelection: (artifactIds: string[]) => void;
  setTyping: (isTyping: boolean) => void;
}

/** Awareness states are peer-supplied — validate before trusting the shape. */
function parseAwarenessState(raw: unknown): AwarenessState | null {
  if (raw === null || typeof raw !== "object") return null;
  const state = raw as Record<string, unknown>;
  if (typeof state.userId !== "string" || state.userId === "") return null;
  if (typeof state.name !== "string" || typeof state.color !== "string") return null;

  let cursor: { x: number; y: number } | null = null;
  const rawCursor = state.cursor;
  if (rawCursor !== null && rawCursor !== undefined && typeof rawCursor === "object") {
    const c = rawCursor as Record<string, unknown>;
    if (typeof c.x === "number" && typeof c.y === "number") cursor = { x: c.x, y: c.y };
  }

  const selection = Array.isArray(state.selection)
    ? state.selection.filter((id): id is string => typeof id === "string")
    : [];

  return {
    userId: state.userId,
    name: state.name,
    color: state.color,
    cursor,
    selection,
    isTyping: state.isTyping === true,
  };
}

const EMPTY_PEERS: AwarenessPeer[] = [];

export function useAwareness(awareness: Awareness | null): UseAwarenessResult {
  const cacheRef = useRef<{
    awareness: Awareness | null;
    version: number;
    computedVersion: number;
    value: AwarenessPeer[];
  }>({ awareness: null, version: 0, computedVersion: -1, value: EMPTY_PEERS });

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!awareness) return () => {};
      const handler = () => {
        cacheRef.current.version += 1;
        onStoreChange();
      };
      awareness.on("change", handler);
      return () => awareness.off("change", handler);
    },
    [awareness],
  );

  const getSnapshot = useCallback(() => {
    const cache = cacheRef.current;
    if (cache.awareness !== awareness) {
      cache.awareness = awareness;
      cache.version += 1;
    }
    if (cache.computedVersion !== cache.version) {
      if (!awareness) {
        cache.value = EMPTY_PEERS;
      } else {
        const peers: AwarenessPeer[] = [];
        awareness.getStates().forEach((raw, clientId) => {
          if (clientId === awareness.clientID) return;
          const state = parseAwarenessState(raw);
          if (state) peers.push({ clientId, state });
        });
        peers.sort((a, b) => a.clientId - b.clientId);
        cache.value = peers;
      }
      cache.computedVersion = cache.version;
    }
    return cache.value;
  }, [awareness]);

  const peers = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_PEERS);

  // --- local state setters -------------------------------------------------

  const lastCursorSentAtRef = useRef(0);
  const pendingCursorRef = useRef<{ x: number; y: number } | null>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (cursorTimerRef.current !== null) clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
    };
  }, [awareness]);

  const setCursor = useCallback(
    (cursor: { x: number; y: number } | null) => {
      if (!awareness) return;
      pendingCursorRef.current = cursor;
      const flush = () => {
        cursorTimerRef.current = null;
        lastCursorSentAtRef.current = Date.now();
        awareness.setLocalStateField("cursor", pendingCursorRef.current);
      };
      const elapsed = Date.now() - lastCursorSentAtRef.current;
      if (elapsed >= CURSOR_THROTTLE_MS) {
        flush();
      } else if (cursorTimerRef.current === null) {
        cursorTimerRef.current = setTimeout(flush, CURSOR_THROTTLE_MS - elapsed);
      }
    },
    [awareness],
  );

  const setSelection = useCallback(
    (artifactIds: string[]) => {
      if (!awareness) return;
      awareness.setLocalStateField("selection", artifactIds);
    },
    [awareness],
  );

  const setTyping = useCallback(
    (isTyping: boolean) => {
      if (!awareness) return;
      awareness.setLocalStateField("isTyping", isTyping);
    },
    [awareness],
  );

  return { peers, setCursor, setSelection, setTyping };
}
