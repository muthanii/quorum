/**
 * Small helpers shared by every REST route handler: typed JSON errors, zod
 * body parsing, and a last-resort 500 that logs structured JSON but leaks
 * nothing to the client.
 */
import { NextResponse } from "next/server";
import type { z } from "zod";

import { log, serializeError } from "./log";

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } } satisfies ApiErrorBody, { status });
}

/**
 * Read and zod-validate a JSON request body. An empty body parses as `{}` so
 * endpoints with all-optional inputs accept a bare POST.
 */
export async function readJson<Schema extends z.ZodTypeAny>(
  request: Request,
  schema: Schema,
): Promise<{ ok: true; data: z.infer<Schema> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: jsonError(400, "invalid_json", "Request body is not valid JSON."),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return { ok: false, response: jsonError(400, "invalid_body", detail) };
  }
  return { ok: true, data: parsed.data as z.infer<Schema> };
}

/** Log the failure as structured JSON and return an opaque 500. */
export function serverError(event: string, error: unknown): NextResponse {
  log.error(event, serializeError(error));
  return jsonError(500, "internal_error", "Something went wrong on our side. Try again.");
}
