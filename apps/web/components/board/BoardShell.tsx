"use client";

/**
 * Composition root for the board page (brief addendum #2) — the §7 layout:
 * header (name · presence · Share · policy) over CANVAS + CHAT RAIL, with
 * the composer spanning the bottom. Owns the Y.Doc connection and threads
 * live state down; every child stays a leaf client component. The command
 * palette (cmdk) is dynamically imported so it never rides in the initial
 * bundle.
 *
 * The file path, exported name `BoardShell`, and the props contract are
 * pinned by the brief — do not change them.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { activeMemberIds } from "@quorum/shared/consensus/quorum";
import { newId } from "@quorum/shared/ids";
import type { ArtifactType } from "@quorum/shared/schemas/artifact";
import { createProposalInDoc, type ProposalWithVotes } from "@quorum/shared/yjs/doc";

import { AgentRoster } from "@/components/agents/AgentRoster";
import { ConnectAgentCard } from "@/components/agents/ConnectAgentCard";
import type { ArtifactSelector } from "@/components/canvas/ArtifactCard";
import { CanvasSurface } from "@/components/canvas/CanvasSurface";
import { ChatRail } from "@/components/chat/ChatRail";
import { Composer } from "@/components/chat/Composer";
import type { ConsensusContext } from "@/components/chat/ProposalCard";
import { ActiveQuorumIndicator } from "@/components/consensus/ActiveQuorumIndicator";
import { PolicyBadge } from "@/components/consensus/PolicyBadge";
import { ProposalAnnouncer } from "@/components/consensus/ProposalAnnouncer";
import { SharePopover } from "@/components/board/SharePopover";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { api, ApiError } from "@/lib/api/client";
import { useBoard, useCreateInvite } from "@/lib/api/hooks";
import type { BoardDetailDto, BoardSelfDto } from "@/lib/api/types";
import type { MentionTarget } from "@/lib/chat/mentions";
import { useNow } from "@/lib/use-now";
import { createHumanArtifact } from "@/lib/yjs/artifact-write";
import { installE2EHook } from "@/lib/yjs/e2e-hook";
import { useAgentStatuses } from "@/lib/yjs/use-agent-statuses";
import { useArtifacts } from "@/lib/yjs/use-artifacts";
import { useAwareness } from "@/lib/yjs/use-awareness";
import { useBoardDoc } from "@/lib/yjs/use-board-doc";
import { useBoardPolicy } from "@/lib/yjs/use-board-policy";
import { useChat } from "@/lib/yjs/use-chat";
import { useProposals } from "@/lib/yjs/use-proposals";

const CommandPalette = dynamic(
  () => import("@/components/board/CommandPalette").then((mod) => mod.CommandPalette),
  { ssr: false },
);

export interface BoardShellProps {
  boardId: string;
  self: BoardSelfDto;
  wsUrl: string;
  initialBoard: BoardDetailDto;
}

const STATUS_COPY = {
  connected: { label: "Live", variant: "success" as const },
  connecting: { label: "Connecting…", variant: "secondary" as const },
  disconnected: { label: "Offline", variant: "danger" as const },
};

export function BoardShell({ boardId, self, wsUrl, initialBoard }: BoardShellProps) {
  // --- live state ----------------------------------------------------------
  const { doc, awareness, status, synced } = useBoardDoc({ boardId, wsUrl, self });
  const { messages, sendMessage } = useChat(doc, self);
  const artifacts = useArtifacts(doc);
  const { proposals, castVote } = useProposals(doc, self.id);
  const { peers, setCursor, setSelection, setTyping } = useAwareness(awareness);
  const agentStatuses = useAgentStatuses(doc);
  const livePolicy = useBoardPolicy(doc);
  const now = useNow(1000);

  const boardQuery = useBoard(boardId, initialBoard);
  const detail = boardQuery.data ?? initialBoard;
  const members = detail.members;
  const agents = detail.agents;
  // Live doc mirror wins; REST is the fallback for docs without boardMeta.
  const policy = livePolicy ?? detail.board.policy;
  // Role comes from the live REST snapshot, not the server-render prop: an
  // approved invite_member promotes a viewer mid-session and the board must
  // reflect it without a reload (§1.4).
  const selfRole = detail.self.role;
  const canEdit = selfRole !== "viewer";

  // Membership/agents can change under us (invites, other tabs) — refresh the
  // REST snapshot periodically; everything hot is already live via Yjs.
  const queryClient = useQueryClient();
  useEffect(() => {
    const id = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["board", boardId] });
    }, 60_000);
    return () => clearInterval(id);
  }, [queryClient, boardId]);

  // --- quorum + consensus view state --------------------------------------
  const connectedIds = useMemo(() => {
    const ids = peers.map((peer) => peer.state.userId);
    if (status === "connected") ids.push(self.id);
    return ids;
  }, [peers, status, self.id]);

  const activeIds = useMemo(
    () =>
      activeMemberIds({
        members: members.map((member) => ({
          id: member.userId,
          role: member.role,
          lastSeenAt: member.lastSeenAt ?? 0,
        })),
        connectedIds,
        now,
      }),
    [members, connectedIds, now],
  );

  const consensus: ConsensusContext = useMemo(
    () => ({
      members: members.map((member) => ({
        id: member.userId,
        name: member.name,
        role: member.role,
        color: member.color,
      })),
      activeMemberIds: activeIds,
      policy,
      ownerId: detail.board.ownerId,
      selfId: self.id,
      now,
    }),
    [members, activeIds, policy, detail.board.ownerId, self.id, now],
  );

  const authorName = useCallback(
    (proposal: ProposalWithVotes) =>
      proposal.authorKind === "agent"
        ? (agents.find((agent) => agent.id === proposal.authorId)?.name ?? "an agent")
        : (members.find((member) => member.userId === proposal.authorId)?.name ?? "a member"),
    [agents, members],
  );

  const proposalArtifactIds = useMemo(() => {
    const ids = new Set<string>();
    for (const proposal of proposals) {
      if (proposal.status !== "open") continue;
      for (const id of proposal.affectedArtifactIds) ids.add(id);
    }
    return ids;
  }, [proposals]);

  const pendingAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const proposal of proposals) {
      if (proposal.status === "open" && proposal.payload.kind === "add_agent") {
        ids.add(proposal.payload.agentId);
      }
    }
    return ids;
  }, [proposals]);

  // --- selection (local + broadcast via awareness) -------------------------
  const [selection, setSelectionState] = useState<string[]>([]);
  const changeSelection = useCallback(
    (ids: string[]) => {
      setSelectionState((previous) =>
        previous.length === ids.length && previous.every((id, i) => id === ids[i]) ? previous : ids,
      );
      setSelection(ids);
    },
    [setSelection],
  );

  const selectorsByArtifact = useMemo(() => {
    const map = new Map<string, ArtifactSelector[]>();
    for (const peer of peers) {
      for (const artifactId of peer.state.selection) {
        const list = map.get(artifactId) ?? [];
        list.push({ name: peer.state.name, color: peer.state.color });
        map.set(artifactId, list);
      }
    }
    return map;
  }, [peers]);

  const typingNames = useMemo(
    () => peers.filter((peer) => peer.state.isTyping).map((peer) => peer.state.name),
    [peers],
  );

  // --- rail / palette / dialogs -------------------------------------------
  const [railOpen, setRailOpen] = useState(true);
  const [rosterOpen, setRosterOpen] = useState(() => initialBoard.agents.length > 0);
  const [connectOpen, setConnectOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMounted, setPaletteMounted] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setPaletteMounted(true);
        setPaletteOpen((value) => !value);
      } else if (key === "/") {
        event.preventDefault();
        setRailOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // TEST-ONLY (no-op in production builds): window hook for the e2e suite.
  useEffect(() => {
    installE2EHook(doc);
    return () => installE2EHook(null);
  }, [doc]);

  // --- actions -------------------------------------------------------------
  const createArtifact = useCallback(
    (type: ArtifactType) => {
      if (!doc || !synced || !canEdit) return;
      const id = createHumanArtifact(doc, type);
      changeSelection([id]);
    },
    [doc, synced, canEdit, changeSelection],
  );

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const shareLinkInvite = useCreateInvite(boardId);
  const copyShareLink = useCallback(() => {
    shareLinkInvite.mutate(
      { role: "viewer" },
      {
        onSuccess: async (invite) => {
          try {
            await navigator.clipboard.writeText(invite.url);
            setNotice("Share link copied");
          } catch {
            window.prompt("Copy your invite link:", invite.url);
          }
        },
        onError: () => setNotice("Couldn't create a share link — try again"),
      },
    );
  }, [shareLinkInvite]);

  const handleSend = useCallback(
    (content: string, mentions: string[]) => sendMessage(content, mentions) !== null,
    [sendMessage],
  );

  const mentionTargets = useMemo<MentionTarget[]>(
    () => agents.map((agent) => ({ id: agent.id, name: agent.name })),
    [agents],
  );

  // --- editor-invite acceptance: stage the invite_member proposal ----------
  // The invite accept route lands editor invitees as viewers with
  // ?editorRequested=1 (REST cannot write the Y.Doc). Once the doc is
  // synced, stage the proposal exactly once, then strip the flag.
  const stagedEditorRequestRef = useRef(false);
  useEffect(() => {
    if (!doc || !synced || stagedEditorRequestRef.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("editorRequested") !== "1") return;
    const sessionKey = `quorum:editor-requested:${boardId}:${self.id}`;
    stagedEditorRequestRef.current = true;
    if (window.sessionStorage.getItem(sessionKey) === null) {
      window.sessionStorage.setItem(sessionKey, "1");
      const nowMs = Date.now();
      createProposalInDoc(doc, {
        id: newId("proposal"),
        kind: "invite_member",
        title: `Grant editor access to ${self.name}`,
        summary: `${self.name} joined through an editor invite link. They participate as a viewer until everyone approves editor access.`,
        authorId: self.id,
        authorKind: "human",
        createdAt: nowMs,
        expiresAt: nowMs + initialBoard.board.policy.timeoutMs,
        status: "open",
        payload: { kind: "invite_member", role: "editor" },
        affectedArtifactIds: [],
      });
    }
    url.searchParams.delete("editorRequested");
    window.history.replaceState(null, "", url.toString());
  }, [doc, synced, boardId, self.id, self.name, initialBoard.board.policy.timeoutMs]);

  const editorPending = useMemo(
    () =>
      selfRole === "viewer" &&
      proposals.some(
        (p) => p.kind === "invite_member" && p.status === "open" && p.authorId === self.id,
      ),
    [proposals, selfRole, self.id],
  );

  // The ws server marks an approved invite_member "applied" but delegates the
  // grant to the web app; without this the board would report success while
  // the member stayed a viewer forever.
  const claimedEditorRef = useRef(false);
  const [editorClaimError, setEditorClaimError] = useState<string | null>(null);
  useEffect(() => {
    if (selfRole !== "viewer" || claimedEditorRef.current) return;
    const applied = proposals.some(
      (p) => p.kind === "invite_member" && p.status === "applied" && p.authorId === self.id,
    );
    if (!applied) return;
    claimedEditorRef.current = true;
    void api
      .claimEditor(boardId)
      .then(() => {
        setEditorClaimError(null);
        return queryClient.invalidateQueries({ queryKey: ["board", boardId] });
      })
      .catch((error: unknown) => {
        // Never leave an approved decision silently unapplied (§7).
        claimedEditorRef.current = false;
        setEditorClaimError(
          error instanceof ApiError
            ? error.message
            : "Editor access was approved but could not be applied. Reload to retry.",
        );
      });
  }, [proposals, selfRole, self.id, boardId, queryClient]);

  // --- render --------------------------------------------------------------
  const statusInfo = STATUS_COPY[status];
  const connectedSet = useMemo(() => new Set(connectedIds), [connectedIds]);
  const sortedMembers = useMemo(
    () =>
      [...members].sort((a, b) => {
        const ca = connectedSet.has(a.userId) ? 0 : 1;
        const cb = connectedSet.has(b.userId) ? 0 : 1;
        return ca - cb || a.name.localeCompare(b.name);
      }),
    [members, connectedSet],
  );
  const hasDegradedAgent = agents.some(
    (agent) => (agentStatuses[agent.id]?.status ?? agent.status) === "degraded",
  );

  return (
    <div className="flex h-dvh flex-col bg-background">
      <ProposalAnnouncer proposals={proposals} />

      {/* header: board name · presence · Share · policy (CLAUDE.md §7) */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-surface px-4">
        <h1 className="truncate text-ui font-semibold">{detail.board.name}</h1>
        <Badge variant={statusInfo.variant} aria-live="polite">
          {statusInfo.label}
        </Badge>
        <PolicyBadge policy={policy} />
        <ActiveQuorumIndicator count={activeIds.length} />
        {notice ? (
          <span role="status" className="text-xs text-success">
            {notice}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={rosterOpen}
            aria-controls="agent-roster"
            onClick={() => setRosterOpen((value) => !value)}
          >
            <Bot aria-hidden />
            Agents
            <Badge variant="secondary" className="px-1 py-0 text-[10px]">
              {agents.length}
            </Badge>
            {hasDegradedAgent ? (
              <span
                className="size-1.5 rounded-full bg-danger"
                aria-hidden
                title="An agent is degraded"
              />
            ) : null}
            {rosterOpen ? (
              <ChevronUp aria-hidden className="size-3" />
            ) : (
              <ChevronDown aria-hidden className="size-3" />
            )}
          </Button>

          <Separator orientation="vertical" className="h-6" />

          <div className="flex items-center gap-2" aria-label="Board members">
            {sortedMembers.slice(0, 5).map((member) => {
              const online = connectedSet.has(member.userId);
              return (
                <span key={member.userId} className="relative">
                  <Avatar
                    className="size-6"
                    ringColor={member.color}
                    title={`${member.name} (${member.role})${online ? " — online" : ""}`}
                  >
                    <AvatarFallback className="text-[10px]">
                      {member.name.slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  {online ? (
                    <span
                      className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-success ring-2 ring-background"
                      aria-hidden
                    />
                  ) : null}
                </span>
              );
            })}
            {sortedMembers.length > 5 ? (
              <span className="text-xs text-muted">+{sortedMembers.length - 5}</span>
            ) : null}
          </div>

          <SharePopover boardId={boardId} disabled={self.role === "viewer"} />

          <Button
            variant="ghost"
            size="sm"
            aria-label="Open command palette"
            onClick={() => {
              setPaletteMounted(true);
              setPaletteOpen(true);
            }}
          >
            <Kbd>⌘K</Kbd>
          </Button>
        </div>
      </header>

      {rosterOpen ? (
        <AgentRoster
          agents={agents}
          statuses={agentStatuses}
          pendingAgentIds={pendingAgentIds}
          canConnect={canEdit}
          onConnectAgent={() => setConnectOpen(true)}
        />
      ) : null}

      {editorPending ? (
        <div className="border-b bg-warning/10 px-4 py-2 text-xs text-warning" role="status">
          You joined with an editor invite. You&apos;re a viewer until every active member approves
          editor access — the request is in the chat rail for them to vote on.
        </div>
      ) : null}

      {editorClaimError !== null ? (
        <div className="border-b bg-danger/10 px-4 py-2 text-xs text-danger" role="alert">
          {editorClaimError}
        </div>
      ) : null}

      {/* canvas + chat rail */}
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <CanvasSurface
            doc={doc}
            synced={synced}
            artifacts={artifacts}
            peers={peers}
            selfColor={self.color}
            canEdit={canEdit}
            selection={selection}
            onSelectionChange={changeSelection}
            onCursor={setCursor}
            proposalArtifactIds={proposalArtifactIds}
            selectorsByArtifact={selectorsByArtifact}
            onConnectAgent={() => setConnectOpen(true)}
            onCreateArtifact={createArtifact}
          />
        </main>

        {railOpen ? (
          <ChatRail
            messages={messages}
            proposals={proposals}
            consensus={consensus}
            authorName={authorName}
            onVote={castVote}
            typingNames={typingNames}
            synced={synced}
          />
        ) : null}
      </div>

      {/* composer spans the bottom (§7 layout) */}
      <Composer
        disabled={!canEdit || !synced}
        disabledReason={!canEdit ? "Viewers can read, not post" : "Connecting…"}
        agents={mentionTargets}
        onSend={handleSend}
        onTyping={setTyping}
      />

      <ConnectAgentCard
        boardId={boardId}
        doc={doc}
        open={connectOpen}
        onOpenChange={setConnectOpen}
      />

      {paletteMounted ? (
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          canEdit={canEdit}
          onNewDoc={() => createArtifact("doc")}
          onNewTable={() => createArtifact("table")}
          onConnectAgent={() => setConnectOpen(true)}
          onCopyShareLink={copyShareLink}
          onToggleRail={() => setRailOpen((value) => !value)}
        />
      ) : null}
    </div>
  );
}
