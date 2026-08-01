"use client";

/**
 * A blank board teaches (CLAUDE.md §7): the connect-an-agent card front and
 * center, with direct artifact creation as the secondary path. Viewers get an
 * explanation instead of dead buttons.
 */
import { Bot, FileText, Plus, Table2 } from "lucide-react";

import type { ArtifactType } from "@quorum/shared/schemas/artifact";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface EmptyStateProps {
  canEdit: boolean;
  onConnectAgent: () => void;
  onCreateArtifact: (type: ArtifactType) => void;
}

export function EmptyState({ canEdit, onConnectAgent, onCreateArtifact }: EmptyStateProps) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <Card className="pointer-events-auto w-full max-w-sm items-center text-center">
        <CardHeader className="items-center">
          <div className="mx-auto mb-1 flex size-10 items-center justify-center rounded-panel border bg-raised">
            <Bot aria-hidden className="size-5 text-accent" />
          </div>
          <CardTitle>Connect an agent</CardTitle>
          <CardDescription>
            Paste a webhook URL or an API key and your agent joins the room. Everything it makes
            lands here for everyone to see — and nothing ships without everyone&apos;s yes.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex w-full flex-col items-center gap-3">
          {canEdit ? (
            <>
              <Button onClick={onConnectAgent}>
                <Plus aria-hidden />
                Connect an agent
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => onCreateArtifact("doc")}>
                  <FileText aria-hidden />
                  New doc
                </Button>
                <Button variant="secondary" size="sm" onClick={() => onCreateArtifact("table")}>
                  <Table2 aria-hidden />
                  New table
                </Button>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">
              You&apos;re viewing. Ask anyone on the board for an editor invite to add agents or
              artifacts.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
