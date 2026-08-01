/**
 * Structured JSON logging (one object per line). No secrets ever reach a log
 * line by construction: the ws server never loads credential columns, so
 * there is nothing secret to accidentally serialize.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Errors are not JSON-serializable — project them to plain fields. */
export function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack };
  }
  return { errorMessage: String(error) };
}

function write(level: LogLevel, msg: string, fields: LogFields): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  if (level === "error" || level === "warn") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export function createLogger(base: LogFields = {}): Logger {
  const log = (level: LogLevel, msg: string, fields?: LogFields): void =>
    write(level, msg, { ...base, ...fields });
  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

/** A logger that records nothing — for tests. */
export function nullLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => nullLogger(),
  };
}
