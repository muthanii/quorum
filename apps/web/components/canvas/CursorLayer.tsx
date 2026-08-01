"use client";

/**
 * Remote peers' cursors, rendered in canvas (world) space inside the panned
 * layer. Positions move via a short CSS transform transition so cursors
 * interpolate instead of teleporting; the global prefers-reduced-motion reset
 * collapses that transition for users who ask for it. Name labels fade after
 * 2s of stillness. Purely decorative for AT — the presence stack in the
 * header is the accessible signal.
 */
import { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";

import { contrastingTextColor } from "@quorum/shared/colors";

import type { AwarenessPeer } from "@/lib/yjs/use-awareness";
import { cn } from "@/lib/utils";

export function CursorLayer({ peers }: { peers: AwarenessPeer[] }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {peers.map((peer) =>
        peer.state.cursor ? (
          <PeerCursor
            key={peer.clientId}
            name={peer.state.name}
            color={peer.state.color}
            x={peer.state.cursor.x}
            y={peer.state.cursor.y}
          />
        ) : null,
      )}
    </div>
  );
}

function PeerCursor({ name, color, x, y }: { name: string; color: string; x: number; y: number }) {
  const [still, setStill] = useState(false);

  useEffect(() => {
    setStill(false);
    const timer = setTimeout(() => setStill(true), 2000);
    return () => clearTimeout(timer);
  }, [x, y]);

  return (
    <div
      className="absolute top-0 left-0 transition-transform duration-(--duration-fast) ease-linear will-change-transform"
      style={{ transform: `translate(${x}px, ${y}px)` }}
    >
      <MousePointer2 className="size-4 drop-shadow-sm" style={{ color, fill: color }} />
      <span
        className={cn(
          "absolute top-4 left-3 rounded-control px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap transition-opacity duration-(--duration-slow) ease-standard",
          still ? "opacity-0" : "opacity-100",
        )}
        style={{ backgroundColor: color, color: contrastingTextColor(color) }}
      >
        {name}
      </span>
    </div>
  );
}
