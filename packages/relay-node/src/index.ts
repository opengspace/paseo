/**
 * @getpaseo/relay-node — self-hostable Node.js relay for Paseo.
 *
 * A protocol-compatible, zero-knowledge WebSocket relay that mirrors the
 * Cloudflare relay (packages/relay). Run your own on any host reachable from your network
 * behind a TLS-terminating reverse proxy.
 */

export { createRelayServer } from "./relay-server.js";
export type { RelayServerOptions } from "./relay-server.js";

export { RelaySession } from "./relay-session.js";
export type { RelaySessionDeps } from "./relay-session.js";

export { TaggedSocketIndex } from "./tagged-sockets.js";

export { createLogger, parseLogLevel } from "./logger.js";
export type { Logger, LogLevel } from "./logger.js";

export { resolveRelayVersion, CURRENT_RELAY_VERSION, LEGACY_RELAY_VERSION } from "./version.js";
export type { RelayProtocolVersion } from "./version.js";

export { loadConfig } from "./config.js";
export type { RelayConfig } from "./config.js";

export type { ConnectionRole, RelaySessionAttachment } from "./types.js";
