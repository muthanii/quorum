"use client";

/**
 * Shared subscription core for the Yjs hooks: subscribe to a Y type with
 * observeDeep and expose a cached, referentially-stable snapshot through
 * useSyncExternalStore. Doc state is NEVER mirrored into useState — the doc
 * is the store, this only versions and caches reads from it.
 */
import { useCallback, useRef, useSyncExternalStore } from "react";

/** Structural slice of Y.AbstractType — keeps the generics out of the way. */
export interface YObservable {
  observeDeep(handler: () => void): void;
  unobserveDeep(handler: () => void): void;
}

interface SnapshotCache<T> {
  target: YObservable | null;
  version: number;
  computedVersion: number;
  value: T;
}

export function useYSnapshot<T>(target: YObservable | null, compute: () => T, empty: T): T {
  const cacheRef = useRef<SnapshotCache<T>>({
    target: null,
    version: 0,
    computedVersion: -1,
    value: empty,
  });

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!target) return () => {};
      const handler = () => {
        cacheRef.current.version += 1;
        onStoreChange();
      };
      target.observeDeep(handler);
      return () => target.unobserveDeep(handler);
    },
    [target],
  );

  const getSnapshot = useCallback(() => {
    const cache = cacheRef.current;
    if (cache.target !== target) {
      cache.target = target;
      cache.version += 1;
    }
    if (cache.computedVersion !== cache.version) {
      cache.value = target ? compute() : empty;
      cache.computedVersion = cache.version;
    }
    return cache.value;
    // `compute` is intentionally not a dependency: it is an inline closure at
    // every call site and only ever reads from `target`, which IS tracked.
  }, [target, empty]);

  // Server snapshot: there is never a live doc during SSR.
  const getServerSnapshot = useCallback(() => empty, [empty]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
