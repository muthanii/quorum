/**
 * One outbound HTTP call with the worker's non-negotiables applied:
 * AbortController deadline covering headers AND body, `redirect: "error"`
 * always (redirects would bypass the SSRF check), and a streaming byte cap so
 * a hostile peer cannot balloon memory past MAX_AGENT_RESPONSE_BYTES.
 */
import { TurnError } from "./errors";

export interface HttpCallInput {
  fetchFn: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface HttpCallResult {
  status: number;
  ok: boolean;
  bodyText: string;
}

export async function httpCall(input: HttpCallInput): Promise<HttpCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    let response: Response;
    try {
      response = await input.fetchFn(input.url, {
        ...input.init,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new TurnError("timeout", `request exceeded ${input.timeoutMs}ms`, {
          retryable: true,
          cause,
        });
      }
      throw new TurnError("network", "request failed before a response arrived", {
        retryable: true,
        cause,
      });
    }
    const bodyText = await readBodyCapped(response, input, controller);
    return { status: response.status, ok: response.ok, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(
  response: Response,
  input: HttpCallInput,
  controller: AbortController,
): Promise<string> {
  const { maxResponseBytes, timeoutMs } = input;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    // Cleanup only — the cap violation below is the surfaced error.
    await response.body?.cancel().catch(() => undefined);
    throw new TurnError(
      "oversized_response",
      `response declares ${declared} bytes, over the ${maxResponseBytes}-byte cap`,
      { retryable: false },
    );
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      step = await reader.read();
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new TurnError("timeout", `response body exceeded the ${timeoutMs}ms deadline`, {
          retryable: true,
          cause,
        });
      }
      throw new TurnError("network", "response body stream failed", { retryable: true, cause });
    }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > maxResponseBytes) {
      // Cleanup only — the cap violation below is the surfaced error.
      await reader.cancel().catch(() => undefined);
      throw new TurnError(
        "oversized_response",
        `response exceeded the ${maxResponseBytes}-byte cap mid-stream`,
        { retryable: false },
      );
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
