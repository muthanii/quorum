"use client";

/**
 * One paste + one click (CLAUDE.md §5): name the agent, paste a webhook URL
 * or a model base URL (+ optional key), connect. On success the per-agent
 * signing secret is shown exactly ONCE with a copy button — it is never
 * retrievable again and never logged — and the add_agent proposal returned by
 * the API is staged into the doc so the whole board votes on activation.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type * as Y from "yjs";

import { createProposalInDoc } from "@quorum/shared/yjs/doc";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/client";
import { useConnectAgent } from "@/lib/api/hooks";
import type { ConnectAgentInput } from "@/lib/api/types";

export interface ConnectAgentCardProps {
  boardId: string;
  doc: Y.Doc | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SuccessState {
  agentName: string;
  signingSecret: string;
  proposalStaged: boolean;
}

export function ConnectAgentCard({ boardId, doc, open, onOpenChange }: ConnectAgentCardProps) {
  const connectAgent = useConnectAgent(boardId);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<"webhook" | "model">("webhook");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [model, setModel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setName("");
    setKind("webhook");
    setEndpointUrl("");
    setSecret("");
    setModel("");
    setFormError(null);
    setSuccess(null);
    setCopied(false);
    connectAgent.reset();
  };

  const close = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const submit = () => {
    setFormError(null);
    const trimmedName = name.trim();
    const trimmedUrl = endpointUrl.trim();
    if (trimmedName === "") return setFormError("Give the agent a name.");
    if (!/^https:\/\//i.test(trimmedUrl)) {
      // The common case behind this is an agent running on the developer's own
      // machine, where "use HTTPS" is not something they can act on. Name the
      // way out, or they are stuck at the first step of the Agent API.
      return setFormError(
        "Agent endpoints must be HTTPS URLs. Running it locally? Expose it with `cloudflared tunnel --url http://localhost:8787` (or `ngrok http 8787`) and paste the https:// URL.",
      );
    }
    const input: ConnectAgentInput = { name: trimmedName, kind, endpointUrl: trimmedUrl };
    if (secret.trim() !== "") input.secret = secret.trim();
    if (kind === "model" && model.trim() !== "") input.model = model.trim();

    connectAgent.mutate(input, {
      onSuccess: (response) => {
        // Stage the add_agent proposal in the live doc — the API cannot write
        // the Y.Doc, so the client does it (see ConnectAgentResponse docs).
        let proposalStaged = false;
        if (doc) {
          try {
            createProposalInDoc(doc, response.proposal);
            proposalStaged = true;
          } catch {
            proposalStaged = false;
          }
        }
        setSuccess({
          agentName: response.agent.name,
          signingSecret: response.signingSecret,
          proposalStaged,
        });
      },
      onError: (error) => {
        setFormError(
          error instanceof ApiError ? error.message : "Could not connect the agent. Try again.",
        );
      },
    });
  };

  const copySecret = async () => {
    if (!success) return;
    try {
      await navigator.clipboard.writeText(success.signingSecret);
      setCopied(true);
    } catch {
      // Clipboard can be blocked — the field below is selectable by hand.
      setCopied(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent aria-describedby={undefined}>
        {success === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect an agent</DialogTitle>
              <DialogDescription>
                Paste an endpoint, click connect. The agent joins once every active member approves
                it — nothing it does lands without everyone&apos;s yes.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="agent-name" className="text-xs font-medium text-muted">
                  Name
                </label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Researcher"
                  maxLength={80}
                />
              </div>
              <div role="group" aria-label="Agent kind" className="flex gap-1">
                <Button
                  type="button"
                  variant={kind === "webhook" ? "default" : "secondary"}
                  size="sm"
                  aria-pressed={kind === "webhook"}
                  onClick={() => setKind("webhook")}
                >
                  Webhook
                </Button>
                <Button
                  type="button"
                  variant={kind === "model" ? "default" : "secondary"}
                  size="sm"
                  aria-pressed={kind === "model"}
                  onClick={() => setKind("model")}
                >
                  Model API
                </Button>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="agent-endpoint" className="text-xs font-medium text-muted">
                  {kind === "webhook" ? "Webhook URL (HTTPS)" : "Base URL (OpenAI/Anthropic-style)"}
                </label>
                <Input
                  id="agent-endpoint"
                  value={endpointUrl}
                  onChange={(event) => setEndpointUrl(event.target.value)}
                  placeholder={
                    kind === "webhook"
                      ? "https://my-agent.example.com/turn"
                      : "https://api.anthropic.com"
                  }
                  inputMode="url"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="agent-secret" className="text-xs font-medium text-muted">
                  {kind === "webhook" ? "Bearer token (optional)" : "API key"}
                </label>
                <Input
                  id="agent-secret"
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder={kind === "webhook" ? "Sent as Authorization: Bearer …" : "sk-…"}
                />
                <p className="text-[11px] text-faint">
                  Encrypted at rest, never shown again — not even to you.
                </p>
              </div>
              {kind === "model" ? (
                <div className="flex flex-col gap-1">
                  <label htmlFor="agent-model" className="text-xs font-medium text-muted">
                    Model name
                  </label>
                  <Input
                    id="agent-model"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="claude-sonnet-4-5"
                  />
                </div>
              ) : null}
              {formError ? (
                <p role="alert" className="text-xs text-danger">
                  {formError}
                </p>
              ) : null}
              <Button onClick={submit} disabled={connectAgent.isPending}>
                {connectAgent.isPending ? "Connecting…" : "Connect agent"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>“{success.agentName}” is connected</DialogTitle>
              <DialogDescription>
                Save this signing secret now — it is shown once and can never be retrieved again.
                Use it to verify the <code className="font-mono">X-Quorum-Signature</code> header on
                every webhook we send.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={success.signingSecret}
                aria-label="Webhook signing secret"
                className="font-mono text-xs"
                onFocus={(event) => event.target.select()}
              />
              <Button
                variant="secondary"
                size="icon"
                onClick={copySecret}
                aria-label="Copy signing secret"
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              </Button>
            </div>
            {copied ? (
              <p role="status" className="text-xs text-success">
                Copied to clipboard.
              </p>
            ) : null}
            <p className="text-xs text-muted">
              {success.proposalStaged
                ? "An approval request is now in the chat rail — the agent participates once every active member approves."
                : "The approval request could not be staged in the live board (connection hiccup). Reopen the board — the agent stays inactive until a vote passes."}
            </p>
            <Button onClick={() => close(false)}>Done</Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
