"use client";

/**
 * The canvas: a pannable world with a subtle dot grid (no zoom in v1).
 * Dragging empty space pans; pointer position is broadcast in WORLD
 * coordinates so every peer sees cursors in the same place regardless of
 * their own pan. Clicking empty space clears the selection.
 */
import { useRef, useState } from "react";
import type * as Y from "yjs";

import type { Artifact, ArtifactType } from "@quorum/shared/schemas/artifact";

import { ArtifactCard, type ArtifactSelector } from "@/components/canvas/ArtifactCard";
import { CursorLayer } from "@/components/canvas/CursorLayer";
import { EmptyState } from "@/components/canvas/EmptyState";
import type { AwarenessPeer } from "@/lib/yjs/use-awareness";

const GRID_SIZE = 24;

export interface CanvasSurfaceProps {
  doc: Y.Doc | null;
  synced: boolean;
  artifacts: Artifact[];
  peers: AwarenessPeer[];
  selfColor: string;
  canEdit: boolean;
  selection: string[];
  onSelectionChange: (artifactIds: string[]) => void;
  onCursor: (cursor: { x: number; y: number } | null) => void;
  /** Artifact ids touched by at least one OPEN proposal (dashed outline). */
  proposalArtifactIds: ReadonlySet<string>;
  /** name+color of each remote peer selecting an artifact, by artifact id. */
  selectorsByArtifact: ReadonlyMap<string, ArtifactSelector[]>;
  onConnectAgent: () => void;
  onCreateArtifact: (type: ArtifactType) => void;
}

interface PanState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
}

export function CanvasSurface({
  doc,
  synced,
  artifacts,
  peers,
  selfColor,
  canEdit,
  selection,
  onSelectionChange,
  onCursor,
  proposalArtifactIds,
  selectorsByArtifact,
  onConnectAgent,
  onCreateArtifact,
}: CanvasSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const panDragRef = useRef<PanState | null>(null);
  const [pan, setPanState] = useState({ x: 0, y: 0 });

  const setPan = (next: { x: number; y: number }) => {
    panRef.current = next;
    setPanState(next);
  };

  const worldPoint = (clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: clientX - rect.left - panRef.current.x, y: clientY - rect.top - panRef.current.y };
  };

  const selectedSet = new Set(selection);
  const EMPTY_SELECTORS: ArtifactSelector[] = [];

  return (
    <div
      ref={surfaceRef}
      role="region"
      aria-label="Canvas"
      className="relative size-full touch-none overflow-hidden bg-background select-none"
      style={{
        backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
        backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
        backgroundPosition: `${pan.x % GRID_SIZE}px ${pan.y % GRID_SIZE}px`,
      }}
      onPointerDown={(event) => {
        // Controls rendered *inside* the canvas (the empty-state actions,
        // artifact chrome) bubble their pointerdown up here. Capturing the
        // pointer would retarget pointerup to this surface, and the browser
        // then never fires `click` on the control — the button silently does
        // nothing. Leave interactive descendants alone.
        if (
          (event.target as HTMLElement).closest(
            "button, a, input, textarea, select, [role='button'], [contenteditable='true']",
          )
        ) {
          return;
        }
        // Panning is a primary-button gesture; let right/middle click through.
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        panDragRef.current = {
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startClientY: event.clientY,
          originX: panRef.current.x,
          originY: panRef.current.y,
        };
        onSelectionChange([]);
      }}
      onPointerMove={(event) => {
        const drag = panDragRef.current;
        if (drag && event.pointerId === drag.pointerId) {
          setPan({
            x: drag.originX + (event.clientX - drag.startClientX),
            y: drag.originY + (event.clientY - drag.startClientY),
          });
        }
        const point = worldPoint(event.clientX, event.clientY);
        if (point) onCursor(point);
      }}
      onPointerUp={(event) => {
        if (panDragRef.current?.pointerId === event.pointerId) panDragRef.current = null;
      }}
      onPointerCancel={() => {
        panDragRef.current = null;
      }}
      onPointerLeave={() => onCursor(null)}
    >
      {/* The panned world: artifacts and remote cursors share this space. */}
      <div className="absolute inset-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        {doc
          ? artifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                doc={doc}
                artifact={artifact}
                selected={selectedSet.has(artifact.id)}
                selfColor={selfColor}
                peerSelectors={selectorsByArtifact.get(artifact.id) ?? EMPTY_SELECTORS}
                hasOpenProposal={proposalArtifactIds.has(artifact.id)}
                canEdit={canEdit}
                onSelect={() => onSelectionChange([artifact.id])}
              />
            ))
          : null}
        <CursorLayer peers={peers} />
      </div>

      {synced && artifacts.length === 0 ? (
        <EmptyState
          canEdit={canEdit}
          onConnectAgent={onConnectAgent}
          onCreateArtifact={onCreateArtifact}
        />
      ) : null}

      {!synced ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <p role="status" className="text-ui text-muted">
            Connecting to the board…
          </p>
        </div>
      ) : null}
    </div>
  );
}
