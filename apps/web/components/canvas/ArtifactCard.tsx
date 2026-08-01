"use client";

/**
 * One artifact on the canvas, absolutely positioned from its meta. Dragging
 * the header writes the position straight into the doc (human move = direct
 * CRDT edit). Selection is broadcast via awareness and rendered as stacked
 * halos in each selector's identity color — paired with name chips, so color
 * is never the only signal. While any open proposal touches this artifact, a
 * dashed outline mirrors the proposal card in the chat rail: the same state,
 * visible in both places at once.
 */
import { useRef } from "react";
import { Bot, FileText, Table2 } from "lucide-react";
import type * as Y from "yjs";

import type { Artifact } from "@quorum/shared/schemas/artifact";
import { contrastingTextColor } from "@quorum/shared/colors";

import { DocArtifactBody } from "@/components/canvas/DocArtifactBody";
import { TableArtifactBody } from "@/components/canvas/TableArtifactBody";
import { Badge } from "@/components/ui/badge";
import { moveArtifact } from "@/lib/yjs/artifact-write";
import { cn } from "@/lib/utils";

export interface ArtifactSelector {
  name: string;
  color: string;
}

export interface ArtifactCardProps {
  doc: Y.Doc;
  artifact: Artifact;
  /** Selected by the local user. */
  selected: boolean;
  selfColor: string;
  /** Remote peers currently selecting this artifact. */
  peerSelectors: ArtifactSelector[];
  hasOpenProposal: boolean;
  canEdit: boolean;
  onSelect: () => void;
}

interface DragState {
  pointerId: number;
  originX: number;
  originY: number;
  startClientX: number;
  startClientY: number;
}

export function ArtifactCard({
  doc,
  artifact,
  selected,
  selfColor,
  peerSelectors,
  hasOpenProposal,
  canEdit,
  onSelect,
}: ArtifactCardProps) {
  const dragRef = useRef<DragState | null>(null);
  const { meta } = artifact;

  // Stacked selection halos: local first, then each remote selector.
  const rings: string[] = [];
  let inset = 0;
  const pushRing = (color: string) => {
    rings.push(`0 0 0 ${inset + 2}px ${color}`);
    inset += 2;
  };
  if (selected) pushRing(selfColor);
  for (const selector of peerSelectors) pushRing(selector.color);

  const TypeIcon = meta.type === "doc" ? FileText : Table2;

  return (
    <article
      tabIndex={0}
      aria-label={`${meta.type === "doc" ? "Document" : "Table"} artifact: ${meta.title}${
        hasOpenProposal ? " (open proposal affects this artifact)" : ""
      }`}
      data-selected={selected || undefined}
      className="absolute top-0 left-0 flex flex-col rounded-panel border bg-surface shadow-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      style={{
        transform: `translate(${meta.x}px, ${meta.y}px)`,
        width: meta.w,
        height: meta.h,
        boxShadow: rings.length > 0 ? rings.join(", ") : undefined,
      }}
      onPointerDown={(event) => {
        // Select, and keep the canvas from starting a pan underneath us.
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      {hasOpenProposal ? (
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-1 rounded-panel border-2 border-dashed border-warning"
        />
      ) : null}

      {peerSelectors.length > 0 ? (
        <div className="absolute right-0 -top-6 flex gap-1">
          {peerSelectors.map((selector) => (
            <span
              key={selector.name + selector.color}
              className="rounded-control px-1.5 py-0.5 text-[10px] leading-4 font-medium whitespace-nowrap"
              style={{
                backgroundColor: selector.color,
                color: contrastingTextColor(selector.color),
              }}
            >
              {selector.name}
            </span>
          ))}
        </div>
      ) : null}

      <header
        className={cn(
          "flex shrink-0 items-center gap-2 border-b px-3 py-2 select-none",
          canEdit && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={(event) => {
          if (!canEdit) return;
          // Selection is handled by the card's own pointerdown as the event
          // bubbles up; here we only start the drag.
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            originX: meta.x,
            originY: meta.y,
            startClientX: event.clientX,
            startClientY: event.clientY,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || event.pointerId !== drag.pointerId) return;
          moveArtifact(
            doc,
            artifact.id,
            drag.originX + (event.clientX - drag.startClientX),
            drag.originY + (event.clientY - drag.startClientY),
          );
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <TypeIcon aria-hidden className="size-4 shrink-0 text-muted" />
        <h3 className="min-w-0 flex-1 truncate text-ui font-medium">{meta.title}</h3>
        {hasOpenProposal ? <Badge variant="warning">Vote open</Badge> : null}
        {meta.authorAgentId !== undefined ? (
          <span title="Created by an agent" className="text-muted">
            <Bot aria-hidden className="size-3.5" />
            <span className="sr-only">Created by an agent</span>
          </span>
        ) : null}
      </header>

      <div className="min-h-0 flex-1">
        {meta.type === "doc" ? (
          <DocArtifactBody
            doc={doc}
            artifactId={artifact.id}
            title={meta.title}
            canEdit={canEdit}
          />
        ) : (
          <TableArtifactBody
            doc={doc}
            artifactId={artifact.id}
            title={meta.title}
            canEdit={canEdit}
          />
        )}
      </div>
    </article>
  );
}
