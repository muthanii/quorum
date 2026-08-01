"use client";

/**
 * Sharing is one click (CLAUDE.md §1.5): the Share button opens a small
 * popover with the role chosen inline — no admin panel — and "Copy link"
 * mints the invite and puts it on the clipboard. Editor invitees land as
 * viewers until the board unanimously approves editor access (the accept
 * route stages that proposal).
 */
import { useState } from "react";
import { Check, Share2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCreateInvite } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";

export interface SharePopoverProps {
  boardId: string;
  disabled: boolean;
}

const ROLE_OPTIONS = [
  {
    role: "viewer" as const,
    label: "Viewer",
    hint: "Watches everything, votes on nothing.",
  },
  {
    role: "editor" as const,
    label: "Editor",
    hint: "Edits and votes — joins as viewer until every active member approves.",
  },
];

export function SharePopover({ boardId, disabled }: SharePopoverProps) {
  const createInvite = useCreateInvite(boardId);
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  const copy = () => {
    setState("idle");
    createInvite.mutate(
      { role },
      {
        onSuccess: async (invite) => {
          try {
            await navigator.clipboard.writeText(invite.url);
            setState("copied");
          } catch {
            // Clipboard can be blocked; the link still exists — show it.
            window.prompt("Copy your invite link:", invite.url);
          }
        },
        onError: () => setState("error"),
      },
    );
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setState("idle");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" disabled={disabled}>
          <Share2 aria-hidden />
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3">
        <div>
          <p className="text-ui font-medium">Share this board</p>
          <p className="text-xs text-muted">A link is the whole flow.</p>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs text-muted">Anyone with the link joins as</legend>
          {ROLE_OPTIONS.map((option) => (
            <label
              key={option.role}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-control border p-2",
                role === option.role ? "border-accent bg-accent/10" : "hover:bg-surface",
              )}
            >
              <input
                type="radio"
                name="invite-role"
                value={option.role}
                checked={role === option.role}
                onChange={() => setRole(option.role)}
                className="mt-0.5 accent-accent"
              />
              <span>
                <span className="block text-ui font-medium">{option.label}</span>
                <span className="text-xs text-muted">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Button onClick={copy} disabled={createInvite.isPending} className="w-full">
          {createInvite.isPending ? (
            "Creating link…"
          ) : state === "copied" ? (
            <>
              <Check aria-hidden />
              Link copied
            </>
          ) : (
            "Copy link"
          )}
        </Button>
        {state === "error" ? (
          <p role="alert" className="text-xs text-danger">
            Couldn&apos;t create the link — try again.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
