/**
 * Minimal leveled logger. No dependencies — keeps the package a self-contained
 * leaf. If structured logging is ever needed, swap this for pino; the surface is
 * intentionally tiny.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const VALID_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (value && VALID_LEVELS.has(value)) return value as LogLevel;
  return fallback;
}

export interface Logger {
  level: LogLevel;
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

type LogSink = (message: string, extra?: unknown) => void;

function sinkFor(at: LogLevel): LogSink {
  if (at === "error") return console.error;
  if (at === "warn") return console.warn;
  return console.log;
}

export function createLogger(level: LogLevel = "info"): Logger {
  const floor = LEVEL_ORDER[level];
  const emit = (at: LogLevel, message: string, extra?: unknown): void => {
    if (LEVEL_ORDER[at] < floor) return;
    const line = `[relay-node] ${message}`;
    const sink = sinkFor(at);
    if (extra === undefined) {
      sink(line);
    } else {
      sink(line, extra);
    }
  };
  return {
    level,
    debug: (message, extra) => emit("debug", message, extra),
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
  };
}
