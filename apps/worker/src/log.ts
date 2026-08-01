/**
 * Structured JSON logging (CLAUDE.md §8): one JSON object per line with a
 * level, message, and stable fields. The sink is injectable so tests can
 * capture lines instead of polluting stdout.
 *
 * SECURITY: never pass credentials, signing secrets, decrypted material, or
 * full agent endpoint URLs (they may embed tokens in query strings) as
 * fields — a logger cannot tell a secret from a string.
 */
export type LogFields = Record<string, unknown>;

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** New logger with `fields` merged into every subsequent line. */
  with(fields: LogFields): Logger;
}

export type LogSink = (line: string, level: LogLevel) => void;

const defaultSink: LogSink = (line, level) => {
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export function createLogger(base: LogFields = {}, sink: LogSink = defaultSink): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    sink(
      JSON.stringify({ level, time: new Date().toISOString(), message, ...base, ...fields }),
      level,
    );
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    with: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}

/**
 * Log-safe view of an unknown error: name, message, and string `code` only.
 * Never serializes whole error objects — they can drag request payloads or
 * headers along via `cause`.
 */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const fields: LogFields = { errorName: err.name, errorMessage: err.message };
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") fields.errorCode = code;
    return fields;
  }
  return { errorMessage: String(err) };
}
