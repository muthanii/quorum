"use client";

/**
 * Live group chat from the Y.Doc "chat" array. Read via the shared typed
 * accessors (malformed entries from hostile peers are skipped there);
 * sending appends through the same validated path.
 */
import { useCallback, useMemo } from "react";
import type * as Y from "yjs";

import { newId } from "@quorum/shared/ids";
import type { Message } from "@quorum/shared/schemas/message";
import { appendMessage, getChat, listMessages } from "@quorum/shared/yjs/doc";

import { useYSnapshot } from "./use-y-snapshot";

const EMPTY_MESSAGES: Message[] = [];

export interface UseChatResult {
  messages: Message[];
  /** Returns the appended message, or null when there is no doc yet. */
  sendMessage: (content: string, mentions?: string[]) => Message | null;
}

export function useChat(
  doc: Y.Doc | null,
  self: { id: string; name: string } | null,
): UseChatResult {
  const chat = useMemo(() => (doc ? getChat(doc) : null), [doc]);

  const messages = useYSnapshot(
    chat,
    () => (doc ? listMessages(doc) : EMPTY_MESSAGES),
    EMPTY_MESSAGES,
  );

  const selfId = self?.id ?? null;
  const selfName = self?.name ?? null;

  const sendMessage = useCallback(
    (content: string, mentions: string[] = []): Message | null => {
      if (!doc || selfId === null || selfName === null) return null;
      return appendMessage(doc, {
        id: newId("message"),
        role: "human",
        authorId: selfId,
        name: selfName,
        content,
        createdAt: Date.now(),
        mentions,
      });
    },
    [doc, selfId, selfName],
  );

  return { messages, sendMessage };
}
