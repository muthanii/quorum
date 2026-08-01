import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@quorum/db/client";
import { encryptSecret, maskSecret } from "@quorum/db/crypto";
import { agents } from "@quorum/db/schema";

import { resolveViewer } from "@/lib/auth/viewer";
import type { BoardAgentDto, ConnectAgentResponse } from "@/lib/api/types";
import { AgentEndpointError, assertSaneAgentEndpoint } from "@/lib/server/agent-endpoint";
import { getMembership } from "@/lib/server/boards";
import { jsonError, readJson, serverError } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { buildHumanProposal } from "@/lib/server/proposals";
import { enforceRateLimit } from "@/lib/server/rate-limit";

interface RouteContext {
  params: Promise<{ boardId: string }>;
}

const connectAgentSchema = z
  .object({
    name: z.string().min(1).max(80),
    kind: z.enum(["webhook", "model"]),
    endpointUrl: z.string().url().max(2048),
    secret: z.string().min(1).max(4096).optional(),
    model: z.string().min(1).max(120).optional(),
  })
  .strict()
  // A model agent without a model name can never run a turn — reject it here
  // rather than letting the worker discover it mid-turn.
  .refine((value) => value.kind !== "model" || value.model !== undefined, {
    message: 'model is required for kind "model"',
    path: ["model"],
  });

/**
 * POST /api/boards/:boardId/agents — connect an agent: one paste, one click
 * (addendum #6).
 *
 * The agent row is created with status "ready", but an add_agent Proposal
 * gates its first activation. REST cannot write the Y.Doc — there is no ws
 * connection in a route handler — so the staged proposal is RETURNED as data
 * and the CLIENT must stage it with createProposalInDoc(doc, proposal). The
 * ws server observes votes and lets the agent participate only once approved.
 *
 * The per-agent webhook signing secret is generated here, stored encrypted,
 * and returned exactly ONCE in this response. It is never retrievable again
 * and never logged.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { boardId } = await context.params;
    // 10/min per board: connecting an agent is a deliberate one-paste action,
    // and every attempt costs an encrypt + insert + staged proposal.
    const limited = await enforceRateLimit(request, {
      bucket: "agents.connect",
      limit: 10,
      windowSec: 60,
      scope: boardId,
    });
    if (limited) return limited;

    const body = await readJson(request, connectAgentSchema);
    if (!body.ok) return body.response;

    const viewer = await resolveViewer();
    if (!viewer) return jsonError(401, "unauthenticated", "Sign in or open an invite link first.");

    const access = await getMembership(boardId, viewer.id);
    if (!access) return jsonError(403, "forbidden", "You are not a member of this board.");
    if (access.membership.role === "viewer") {
      return jsonError(403, "forbidden", "Viewers cannot connect agents.");
    }

    try {
      assertSaneAgentEndpoint(body.data.endpointUrl);
    } catch (error) {
      if (error instanceof AgentEndpointError) {
        return jsonError(400, "invalid_endpoint", error.message);
      }
      throw error;
    }

    const signingSecret = `whsec_${randomBytes(24).toString("base64url")}`;
    const encryptedSigning = encryptSecret(signingSecret);
    const encryptedCredential =
      body.data.secret !== undefined ? encryptSecret(body.data.secret) : null;

    const db = getDb();
    const [agent] = await db
      .insert(agents)
      .values({
        boardId,
        ownerId: viewer.id,
        name: body.data.name,
        kind: body.data.kind,
        endpointUrl: body.data.endpointUrl,
        model: body.data.model ?? null,
        encryptedCredential: encryptedCredential?.ciphertext ?? null,
        credentialIv: encryptedCredential?.iv ?? null,
        credentialTag: encryptedCredential?.tag ?? null,
        maskedKey: body.data.secret !== undefined ? maskSecret(body.data.secret) : null,
        encryptedSigningSecret: encryptedSigning.ciphertext,
        signingSecretIv: encryptedSigning.iv,
        signingSecretTag: encryptedSigning.tag,
        status: "ready",
      })
      .returning({
        id: agents.id,
        ownerId: agents.ownerId,
        name: agents.name,
        kind: agents.kind,
        endpointUrl: agents.endpointUrl,
        maskedKey: agents.maskedKey,
        status: agents.status,
        createdAt: agents.createdAt,
      });
    if (!agent) throw new Error("agent insert returned no row");

    const proposal = buildHumanProposal({
      title: `Add agent "${agent.name}"`,
      summary:
        `${viewer.name} wants to add the ${body.data.kind} agent "${agent.name}" to this board. ` +
        "It will not act until everyone approves.",
      authorId: viewer.id,
      payload: {
        kind: "add_agent",
        agentId: agent.id,
        name: agent.name,
        agentKind: body.data.kind,
      },
      policy: access.board.consensusPolicy,
      now: Date.now(),
    });

    const agentDto: BoardAgentDto = {
      id: agent.id,
      ownerId: agent.ownerId,
      name: agent.name,
      kind: agent.kind,
      endpointHost: new URL(agent.endpointUrl).hostname,
      maskedKey: agent.maskedKey,
      status: agent.status,
      createdAt: agent.createdAt.getTime(),
    };

    // Log ids only — never the credential, never the signing secret.
    log.info("agents.connect", {
      boardId,
      agentId: agent.id,
      kind: body.data.kind,
      ownerId: viewer.id,
    });

    return NextResponse.json(
      { agent: agentDto, signingSecret, proposal } satisfies ConnectAgentResponse,
      { status: 201 },
    );
  } catch (error) {
    return serverError("agents.connect.failed", error);
  }
}
