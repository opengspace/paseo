#!/usr/bin/env node
/**
 * relay-node CLI entry point.
 *
 *   paseo-relay-node [--host 0.0.0.0] [--port 8080] [--log-level info]
 *                    [--max-pending-frames 200]
 *
 * Flags are also read from HOST / PORT / LOG_LEVEL / MAX_PENDING_FRAMES.
 */

import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { createRelayServer } from "../relay-server.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const server = createRelayServer({ logger, maxPendingFrames: config.maxPendingFrames });

server.listen(config.port, config.host, () => {
  logger.info(
    `listening on ws://${config.host}:${config.port}/ws — terminate TLS with a reverse proxy (nginx/caddy) and point your daemon/app relay endpoint here`,
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  // Stop accepting new connections; existing sockets are torn down at process exit.
  server.close(() => process.exit(0));
  // Force-exit if lingering WebSocket connections keep the event loop alive.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
