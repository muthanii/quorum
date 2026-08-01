"use client";

/**
 * Y.Text ⇄ string binding. Reads subscribe to the text; writes go through
 * updateYText, which applies the minimal splice so concurrent peer edits
 * merge instead of being clobbered by a full rewrite.
 */
import { useCallback } from "react";
import type * as Y from "yjs";

import { updateYText } from "@quorum/shared/yjs/text";

import { useYSnapshot } from "./use-y-snapshot";

export interface UseYTextResult {
  value: string;
  setValue: (next: string) => void;
}

export function useYText(text: Y.Text | null): UseYTextResult {
  const value = useYSnapshot(text, () => (text ? text.toString() : ""), "");

  const setValue = useCallback(
    (next: string) => {
      if (!text) return;
      updateYText(text, next);
    },
    [text],
  );

  return { value, setValue };
}
