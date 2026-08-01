/**
 * Structured JSON logging for the server side (CLAUDE.md §8: errors are never
 * swallowed; log structured JSON server-side).
 *
 * NEVER pass credentials, tokens, or cookie values in `fields` — not even
 * truncated. Ids, counts, and error messages only.
 */

type LogFields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack };
  }
  return { errorMessage: String(error) };
}

export const log = {
  info(event: string, fields: LogFields = {}): void {
    emit("info", event, fields);
  },
  warn(event: string, fields: LogFields = {}): void {
    emit("warn", event, fields);
  },
  error(event: string, fields: LogFields = {}): void {
    emit("error", event, fields);
  },
};
