/**
 * @getpaseo/relay-node — self-hostable Node.js relay for Paseo.
 *
 * A protocol-compatible, zero-knowledge WebSocket relay that mirrors the
 * Cloudflare relay (packages/relay). Run your own on any host reachable from your network
 * behind a TLS-terminating reverse proxy.
 *
 * The public surface is intentionally small: start a server with `createRelayServer`.
 * Internals (RelaySession, TaggedSocketIndex, version helpers, config parsing) are not
 * re-exported here — the CLI imports them directly from their modules, so library callers
 * are not coupled to implementation details.
 */

export { createRelayServer } from "./relay-server.js";
export type { RelayServerOptions } from "./relay-server.js";

export { createLogger } from "./logger.js";
export type { Logger, LogLevel } from "./logger.js";
