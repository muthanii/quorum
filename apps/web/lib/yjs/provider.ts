/**
 * Hocuspocus connection factory for a board. One Y.Doc + one Awareness per
 * board connection; the provider fetches a fresh short-lived JWT from
 * POST /api/boards/:boardId/token on every (re)connect, so the 10-minute
 * expiry never strands a session.
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { MemberRole } from "@quorum/shared/schemas/member";
import type { AwarenessState } from "@quorum/shared/yjs/keys";

import { api } from "@/lib/api/client";

export interface BoardSelf {
  /** usr_… — matches the ws token `sub` and the doc's member/vote key space. */
  id: string;
  name: string;
  role: MemberRole;
  /** Identity color from colorForUser — cursor, ring, halo, vote chip. */
  color: string;
}

export interface BoardConnection {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  awareness: Awareness;
  destroy(): void;
}

/**
 * NEXT_PUBLIC_WS_URL is inlined into the browser bundle at build time, so a
 * value of `localhost` is only correct for whoever is sitting at the machine.
 * Loaded from a phone, another laptop, or a tunnel, `localhost` resolves to
 * *that* device and the board hangs at "Connecting…" with nothing in the log.
 *
 * When the configured host is loopback but the page is not, follow the address
 * the page was actually served from. Deployments (where ws lives on its own
 * host) set a real hostname and are untouched.
 */
export function resolveWsUrl(configured: string, location?: { hostname: string }): string {
  if (!location) return configured;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return configured;
  }
  const configuredIsLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const pageIsLoopback = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!configuredIsLoopback || pageIsLoopback) return configured;
  url.hostname = location.hostname;
  return url.toString().replace(/\/$/, "");
}

export function createBoardConnection(options: {
  boardId: string;
  wsUrl: string;
  self: BoardSelf;
}): BoardConnection {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);

  const initialState: AwarenessState = {
    userId: options.self.id,
    name: options.self.name,
    color: options.self.color,
    cursor: null,
    selection: [],
    isTyping: false,
  };
  awareness.setLocalState(initialState);

  const provider = new HocuspocusProvider({
    url: resolveWsUrl(options.wsUrl, typeof window === "undefined" ? undefined : window.location),
    name: options.boardId,
    document: doc,
    awareness,
    token: async () => {
      const { token } = await api.mintBoardToken(options.boardId);
      return token;
    },
  });

  return {
    doc,
    provider,
    awareness,
    destroy() {
      provider.destroy();
      awareness.destroy();
      doc.destroy();
    },
  };
}
