/**
 * CLI/environment configuration for relay-node. Uses node:util parseArgs so the
 * package stays a zero-extra-dependency leaf.
 */

import { parseArgs } from "node:util";
import { parseLogLevel, type LogLevel } from "./logger.js";

export interface RelayConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  maxPendingFrames: number;
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535 (got "${raw}")`);
  }
  return n;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): RelayConfig {
  const { values } = parseArgs({
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "log-level": { type: "string" },
      "max-pending-frames": { type: "string" },
    },
    argv,
  });

  return {
    host: values.host ?? process.env.HOST ?? "0.0.0.0",
    port: parsePort(values.port ?? process.env.PORT, 8080, "port"),
    logLevel: parseLogLevel(values["log-level"] ?? process.env.LOG_LEVEL),
    maxPendingFrames: parseNonNegativeInt(
      values["max-pending-frames"] ?? process.env.MAX_PENDING_FRAMES,
      200,
      "max-pending-frames",
    ),
  };
}
