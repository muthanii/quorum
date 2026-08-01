/**
 * Direct model agents (integration mode B): one chat-completion call against
 * the user's OpenAI-compatible endpoint — or Anthropic-compatible when the
 * base URL mentions "anthropic" — prompting the model to answer with the
 * Agent Protocol v1 response JSON, which is then validated exactly like a
 * webhook agent's response.
 */
import { z } from "zod";

import { type AgentResponse, type TurnPayload } from "@quorum/agent-protocol/v1/types";
import { agentResponseSchema } from "@quorum/shared/schemas/turn";

import { isRetryableHttpStatus, TurnError, zodIssueSummary } from "./errors";
import { httpCall } from "./http";

export interface ModelEndpoint {
  /** OpenAI-style base URL including any /v1 prefix, no trailing slash. */
  baseUrl: string;
  model: string;
}

/**
 * A model agent needs both a base URL and a model name; the connect flow stores
 * them in the endpoint_url and model columns. A missing model name is a
 * configuration error, never a silent default.
 */
export function parseModelEndpoint(endpointUrl: string, model: string | null): ModelEndpoint {
  if (model === null || model.trim() === "") {
    throw new TurnError(
      "agent_not_configured",
      "model agent has no model name stored — reconnect the agent with a model",
      { retryable: false },
    );
  }
  return { baseUrl: endpointUrl.replace(/\/+$/, ""), model: model.trim() };
}

export interface ModelTurnInput {
  payload: TurnPayload;
  endpointUrl: string;
  /** Model name from the agent row; null fails the turn as misconfigured. */
  model: string | null;
  /** Decrypted API key. NEVER log it or place it anywhere but the auth header. */
  apiKey: string | null;
  fetchFn: typeof fetch;
  timeoutMs: number;
  maxResponseBytes: number;
}

export async function runModelTurn(input: ModelTurnInput): Promise<AgentResponse> {
  const endpoint = parseModelEndpoint(input.endpointUrl, input.model);
  const isAnthropic = endpoint.baseUrl.toLowerCase().includes("anthropic");
  const reply = isAnthropic
    ? await callAnthropic(input, endpoint)
    : await callOpenAi(input, endpoint);
  const parsed = agentResponseSchema.safeParse(parseModelReply(reply));
  if (!parsed.success) {
    throw new TurnError(
      "invalid_response",
      `model reply failed Agent Protocol validation: ${zodIssueSummary(parsed.error)}`,
      { retryable: false },
    );
  }
  return parsed.data;
}

function systemPrompt(payload: TurnPayload): string {
  return [
    `You are "${payload.agent.name}" (${payload.agent.id}), an AI agent collaborating on Quorum board ${payload.boardId}.`,
    "Quorum is a shared board where humans and agents work together. Every operation you emit is",
    "staged as a proposal and applied only after the board's members approve it — nothing you do",
    "takes effect directly.",
    `Your capabilities this turn: ${payload.capabilities.join(", ")}.`,
    "Respond with a single JSON object and nothing else, shaped exactly as:",
    '{"messages":[{"content":"<chat message>"}],"operations":[]}',
    "Allowed entries in operations:",
    '- {"op":"artifact.create","type":"doc"|"table","title":"...","content":"..."}',
    '- {"op":"artifact.patch","artifactId":"art_...","patch":[<RFC 6902 operations>]}',
    '- {"op":"proposal.create","title":"...","summary":"...","operation":<artifact op>}',
    '- {"op":"proposal.create","title":"...","summary":"...","prompt":{"targetAgentId":"agt_...","content":"..."}}',
    "Use empty arrays when you have nothing to say or stage.",
  ].join("\n");
}

function userPrompt(payload: TurnPayload): string {
  return [
    `Trigger: ${payload.trigger.type}`,
    "Board context as JSON (chat tail, canvas artifacts, open proposals):",
    JSON.stringify(payload.context),
  ].join("\n");
}

const openAiReplySchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
});

async function callOpenAi(input: ModelTurnInput, endpoint: ModelEndpoint): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.apiKey !== null) headers.authorization = `Bearer ${input.apiKey}`;
  const body = JSON.stringify({
    model: endpoint.model,
    messages: [
      { role: "system", content: systemPrompt(input.payload) },
      { role: "user", content: userPrompt(input.payload) },
    ],
  });
  const raw = await callModelEndpoint(input, `${endpoint.baseUrl}/chat/completions`, headers, body);
  const parsed = openAiReplySchema.safeParse(raw);
  const content = parsed.success ? parsed.data.choices[0]?.message.content : undefined;
  if (typeof content !== "string" || content === "") {
    throw new TurnError("malformed_response", "model endpoint returned no completion text", {
      retryable: false,
    });
  }
  return content;
}

const anthropicReplySchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

async function callAnthropic(input: ModelTurnInput, endpoint: ModelEndpoint): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (input.apiKey !== null) headers["x-api-key"] = input.apiKey;
  const body = JSON.stringify({
    model: endpoint.model,
    max_tokens: 4096,
    system: systemPrompt(input.payload),
    messages: [{ role: "user", content: userPrompt(input.payload) }],
  });
  const url = endpoint.baseUrl.endsWith("/v1")
    ? `${endpoint.baseUrl}/messages`
    : `${endpoint.baseUrl}/v1/messages`;
  const raw = await callModelEndpoint(input, url, headers, body);
  const parsed = anthropicReplySchema.safeParse(raw);
  const text = parsed.success
    ? parsed.data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
    : "";
  if (text === "") {
    throw new TurnError("malformed_response", "model endpoint returned no text blocks", {
      retryable: false,
    });
  }
  return text;
}

async function callModelEndpoint(
  input: ModelTurnInput,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<unknown> {
  const result = await httpCall({
    fetchFn: input.fetchFn,
    url,
    init: { method: "POST", headers, body },
    timeoutMs: input.timeoutMs,
    maxResponseBytes: input.maxResponseBytes,
  });
  if (!result.ok) {
    throw new TurnError("model_http_error", `model endpoint answered ${result.status}`, {
      retryable: isRetryableHttpStatus(result.status),
    });
  }
  try {
    return JSON.parse(result.bodyText) as unknown;
  } catch (cause) {
    throw new TurnError("malformed_response", "model endpoint returned non-JSON", {
      retryable: false,
      cause,
    });
  }
}

/**
 * Models are told to reply with bare JSON but routinely wrap it in a fenced
 * code block — tolerate that, nothing more.
 */
export function parseModelReply(reply: string): unknown {
  const candidates = [reply.trim()];
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(reply);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // fall through to the next candidate
    }
  }
  throw new TurnError("malformed_response", "model reply was not parseable JSON", {
    retryable: false,
  });
}
