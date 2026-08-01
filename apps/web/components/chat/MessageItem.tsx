"use client";

/**
 * One group-chat entry. Human content renders as plain text (React-escaped).
 * Agent content is treated as hostile (CLAUDE.md §8): sanitized with
 * DOMPurify against a small allowlist before rendering. Author identity uses
 * the shared color derivation — the same color as their cursor and votes —
 * always paired with the name, never color alone.
 */
import DOMPurify from "dompurify";
import { Bot } from "lucide-react";

import { colorForUser } from "@quorum/shared/colors";
import type { Message } from "@quorum/shared/schemas/message";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

/** Minimal formatting allowlist for agent-produced content. */
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "s",
    "code",
    "pre",
    "ul",
    "ol",
    "li",
    "a",
    "h1",
    "h2",
    "h3",
    "h4",
    "blockquote",
    "hr",
  ],
  ALLOWED_ATTR: ["href", "title"],
};

function formatTime(createdAt: number): string {
  return new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MessageItem({ message }: { message: Message }) {
  const color = colorForUser(message.authorId);
  const isAgent = message.role === "agent";

  return (
    <div className="flex gap-2">
      <Avatar className="mt-0.5 size-6" ringColor={color} title={message.name}>
        <AvatarFallback className="text-[10px]">{message.name.slice(0, 2)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-xs font-medium" style={{ color }}>
            {message.name}
          </span>
          {isAgent ? (
            <Badge variant="secondary" className="gap-0.5 px-1 py-0 text-[10px]">
              <Bot aria-hidden className="size-2.5" />
              agent
            </Badge>
          ) : null}
          <time
            className="shrink-0 text-[10px] text-faint"
            dateTime={new Date(message.createdAt).toISOString()}
          >
            {formatTime(message.createdAt)}
          </time>
        </div>
        {isAgent ? (
          <div
            className="text-ui break-words whitespace-pre-wrap [&_a]:text-accent [&_a]:underline [&_code]:font-mono [&_code]:text-xs [&_pre]:overflow-x-auto [&_pre]:rounded-control [&_pre]:bg-raised [&_pre]:p-2"
            // Sanitized above — agent output never reaches the DOM raw.
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(message.content, SANITIZE_CONFIG),
            }}
          />
        ) : (
          <p className="text-ui break-words whitespace-pre-wrap">{message.content}</p>
        )}
      </div>
    </div>
  );
}
