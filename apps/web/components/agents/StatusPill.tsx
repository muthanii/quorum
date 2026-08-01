"use client";

/**
 * Agent roster status pill: ready / running / degraded. The dot color is
 * paired with a text label, so color is never the only signal.
 */
import type { AgentStatus } from "@quorum/shared/schemas/agent";

import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<AgentStatus, { label: string; dot: string; text: string }> = {
  ready: { label: "Ready", dot: "bg-success", text: "text-success" },
  running: { label: "Running", dot: "bg-accent animate-pulse", text: "text-accent" },
  degraded: { label: "Degraded", dot: "bg-danger", text: "text-danger" },
};

export function StatusPill({ status, className }: { status: AgentStatus; className?: string }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-control border bg-raised px-1.5 py-0.5 text-[11px] font-medium",
        style.text,
        className,
      )}
      title={
        status === "degraded"
          ? "This agent's endpoint kept failing — check its URL and credentials."
          : undefined
      }
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", style.dot)} />
      {style.label}
    </span>
  );
}
