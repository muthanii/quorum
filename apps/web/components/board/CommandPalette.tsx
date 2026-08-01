"use client";

/**
 * ⌘K command palette — cmdk rendered inside the shared dialog primitive.
 * This module is dynamically imported by BoardShell so cmdk stays out of the
 * initial board bundle (250KB budget, CLAUDE.md §1.6).
 */
import { Command } from "cmdk";
import { Bot, FileText, Link2, PanelRight, Table2 } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  onNewDoc: () => void;
  onNewTable: () => void;
  onConnectAgent: () => void;
  onCopyShareLink: () => void;
  onToggleRail: () => void;
}

const ITEM_CLASS =
  "flex cursor-default items-center gap-2 rounded-control px-2 py-2 text-ui outline-none select-none data-[selected=true]:bg-accent/15 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted";

export function CommandPalette({
  open,
  onOpenChange,
  canEdit,
  onNewDoc,
  onNewTable,
  onConnectAgent,
  onCopyShareLink,
  onToggleRail,
}: CommandPaletteProps) {
  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="top-[24%] max-w-lg gap-0 p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command label="Command palette" loop>
          <Command.Input
            placeholder="Type a command…"
            className="h-11 w-full border-b bg-transparent px-4 text-ui text-foreground outline-none placeholder:text-faint"
          />
          <Command.List className="max-h-72 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-ui text-muted">
              No matching command.
            </Command.Empty>
            {canEdit ? (
              <>
                <Command.Item className={ITEM_CLASS} onSelect={() => run(onNewDoc)}>
                  <FileText aria-hidden />
                  New doc artifact
                </Command.Item>
                <Command.Item className={ITEM_CLASS} onSelect={() => run(onNewTable)}>
                  <Table2 aria-hidden />
                  New table artifact
                </Command.Item>
                <Command.Item className={ITEM_CLASS} onSelect={() => run(onConnectAgent)}>
                  <Bot aria-hidden />
                  Connect an agent
                </Command.Item>
                <Command.Item className={ITEM_CLASS} onSelect={() => run(onCopyShareLink)}>
                  <Link2 aria-hidden />
                  Copy share link
                </Command.Item>
              </>
            ) : null}
            <Command.Item className={ITEM_CLASS} onSelect={() => run(onToggleRail)}>
              <PanelRight aria-hidden />
              Toggle chat rail
              <span className="ml-auto">
                <Kbd>⌘/</Kbd>
              </span>
            </Command.Item>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
