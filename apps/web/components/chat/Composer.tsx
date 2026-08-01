"use client";

/**
 * The bottom composer: message everyone, ⌘Enter to send, @mention an agent
 * via an inline listbox (arrow keys + Enter — keyboard stays in the
 * textarea, aria-activedescendant tracks the highlight), or flip the
 * broadcast toggle to trigger every ready agent (mentions == ["*"]). Typing
 * is broadcast through awareness while the draft is being edited.
 */
import { useEffect, useRef, useState } from "react";
import { Bot, RadioTower } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import {
  BROADCAST_MENTION,
  extractMentions,
  mentionQueryAt,
  type MentionTarget,
} from "@/lib/chat/mentions";
import { cn } from "@/lib/utils";

const TYPING_IDLE_MS = 2000;

export interface ComposerProps {
  disabled: boolean;
  disabledReason?: string;
  /** Mentionable agents on this board. */
  agents: readonly MentionTarget[];
  /** Returns true when the message was appended to the doc. */
  onSend: (content: string, mentions: string[]) => boolean;
  onTyping: (isTyping: boolean) => void;
}

interface MentionState {
  query: string;
  start: number;
  index: number;
}

export function Composer({ disabled, disabledReason, agents, onSend, onTyping }: ComposerProps) {
  // The Textarea primitive doesn't expose a ref; reach the element through
  // its wrapper instead of hand-editing components/ui.
  const fieldWrapRef = useRef<HTMLDivElement | null>(null);
  const getTextarea = () => fieldWrapRef.current?.querySelector("textarea") ?? null;
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draft, setDraft] = useState("");
  const [broadcast, setBroadcast] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current !== null) clearTimeout(typingTimerRef.current);
      onTyping(false);
    };
    // Unmount-only cleanup; onTyping is stable from useAwareness.
  }, []);

  const noteTyping = () => {
    onTyping(true);
    if (typingTimerRef.current !== null) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => onTyping(false), TYPING_IDLE_MS);
  };

  const filtered =
    mention === null
      ? []
      : agents.filter((agent) => agent.name.toLowerCase().startsWith(mention.query.toLowerCase()));

  const refreshMention = (text: string, caret: number) => {
    if (agents.length === 0) {
      setMention(null);
      return;
    }
    const query = mentionQueryAt(text, caret);
    setMention(query ? { query: query.query, start: query.start, index: 0 } : null);
  };

  const pick = (agent: MentionTarget) => {
    const el = getTextarea();
    if (!el || mention === null) return;
    const caret = el.selectionStart ?? draft.length;
    const next = `${draft.slice(0, mention.start)}@${agent.name} ${draft.slice(caret)}`;
    const pos = mention.start + agent.name.length + 2;
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const submit = () => {
    const content = draft.trim();
    if (content === "" || disabled) return;
    const mentions = broadcast ? [BROADCAST_MENTION] : extractMentions(content, agents);
    if (onSend(content, mentions)) {
      setDraft("");
      setMention(null);
      setBroadcast(false);
      if (typingTimerRef.current !== null) clearTimeout(typingTimerRef.current);
      onTyping(false);
    }
  };

  const activeOption = mention !== null ? filtered[mention.index] : undefined;

  return (
    <div className="relative shrink-0 border-t bg-surface px-4 py-3">
      {mention !== null && filtered.length > 0 ? (
        <ul
          id="composer-mention-listbox"
          role="listbox"
          aria-label="Mention an agent"
          className="absolute bottom-full left-4 z-10 mb-1 w-64 rounded-panel border bg-raised p-1 shadow-lg"
        >
          {filtered.map((agent, index) => (
            <li
              key={agent.id}
              id={`composer-mention-${agent.id}`}
              role="option"
              aria-selected={index === mention.index}
              className={cn(
                "flex cursor-default items-center gap-2 rounded-control px-2 py-1.5 text-ui",
                index === mention.index && "bg-accent/15",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(agent);
              }}
              onMouseEnter={() => setMention({ ...mention, index })}
            >
              <Bot aria-hidden className="size-4 text-muted" />
              <span className="truncate">{agent.name}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-end gap-2">
        <div ref={fieldWrapRef} className="min-w-0 flex-1">
          <Textarea
            rows={2}
            value={draft}
            disabled={disabled}
            placeholder={
              disabled ? (disabledReason ?? "…") : "Message the board — @ mentions an agent"
            }
            aria-label="Message the board"
            role="combobox"
            aria-expanded={mention !== null && filtered.length > 0}
            aria-controls="composer-mention-listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? `composer-mention-${activeOption.id}` : undefined}
            className="min-h-0 w-full resize-none"
            onChange={(event) => {
              setDraft(event.target.value);
              noteTyping();
              refreshMention(event.target.value, event.target.selectionStart ?? 0);
            }}
            onSelect={(event) => {
              const el = event.currentTarget;
              refreshMention(el.value, el.selectionStart ?? 0);
            }}
            onKeyDown={(event) => {
              if (mention !== null && filtered.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMention({ ...mention, index: (mention.index + 1) % filtered.length });
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMention({
                    ...mention,
                    index: (mention.index - 1 + filtered.length) % filtered.length,
                  });
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  const target = filtered[mention.index];
                  if (target) {
                    event.preventDefault();
                    pick(target);
                    return;
                  }
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMention(null);
                  return;
                }
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div className="flex flex-col items-end gap-2">
          <Button
            type="button"
            variant={broadcast ? "default" : "ghost"}
            size="sm"
            aria-pressed={broadcast}
            disabled={disabled || agents.length === 0}
            title="Broadcast: trigger every ready agent with this message"
            onClick={() => setBroadcast((value) => !value)}
          >
            <RadioTower aria-hidden />
            Broadcast
          </Button>
          <Button size="sm" onClick={submit} disabled={disabled || draft.trim() === ""}>
            Send
          </Button>
        </div>
      </div>

      <div className="mt-1 flex items-center gap-3 text-[11px] text-faint">
        <span>
          <Kbd>⌘⏎</Kbd> send
        </span>
        <span>@ mentions an agent</span>
        {broadcast ? (
          <span className="text-warning" role="status">
            Broadcasting to every ready agent
          </span>
        ) : null}
        {disabled && disabledReason ? <span role="status">{disabledReason}</span> : null}
      </div>
    </div>
  );
}
