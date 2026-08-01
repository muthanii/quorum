/**
 * Typed turn-processing failures. `retryable` drives BullMQ behavior in
 * main.ts: retryable errors burn an attempt and back off; non-retryable ones
 * become UnrecoverableError so the job fails immediately and the agent is
 * marked degraded without pointless re-calls.
 */
import { type z } from "zod";

export type TurnErrorCode =
  | "invalid_job"
  | "agent_not_found"
  | "agent_board_mismatch"
  | "agent_not_configured"
  | "ssrf_rejected"
  | "timeout"
  | "network"
  | "agent_http_error"
  | "model_http_error"
  | "oversized_response"
  | "malformed_response"
  | "invalid_response"
  | "result_post_failed";

export class TurnError extends Error {
  readonly code: TurnErrorCode;
  readonly retryable: boolean;

  constructor(code: TurnErrorCode, message: string, opts: { retryable: boolean; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "TurnError";
    this.code = code;
    this.retryable = opts.retryable;
  }
}

/** Compact, secret-free summary of a zod failure for error messages. */
export function zodIssueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Transient HTTP statuses worth retrying; everything else 4xx is the peer's bug. */
export function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}
