/**
 * relay-node HTTP + WebSocket server — a faithful port of the Cloudflare Worker
 * entry point (packages/relay/src/cloudflare-adapter.ts default export).
 *
 * Wire contract (owned by packages/protocol/src/daemon-endpoints.ts):
 *   GET  /health                          -> {"status":"ok"}
 *   GET  /ws (non-upgrade)                -> 426
 *   WS   /ws?serverId=&role=server|client&v=1|2&connectionId=
 *
 * Each (version, serverId) gets its own RelaySession, mirroring the per-session
 * Cloudflare Durable Object. Sessions are evicted once they hold zero sockets.
 *
 * The server speaks plain `ws` only — terminate TLS with a reverse proxy
 * (nginx/caddy) in front. The daemon and app select ws/wss from the configured
 * relay endpoint.
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { RelaySession } from "./relay-session.js";
import { resolveRelayVersion, type RelayProtocolVersion } from "./version.js";
import type { ConnectionRole } from "./types.js";
import { createLogger, type Logger } from "./logger.js";

export interface RelayServerOptions {
  logger?: Logger;
  /** Per-connectionId cap on buffered frames awaiting a server-data socket. */
  maxPendingFrames?: number;
}

export function createRelayServer(options: RelayServerOptions = {}): http.Server {
  const logger = options.logger ?? createLogger("info");
  const maxPendingFrames = options.maxPendingFrames ?? 200;
  const sessions = new Map<string, RelaySession>();

  const getOrCreateSession = (version: RelayProtocolVersion, serverId: string): RelaySession => {
    const key = `relay-v${version}:${serverId}`;
    let session = sessions.get(key);
    if (session) return session;

    session = new RelaySession({
      version,
      serverId,
      logger,
      maxPendingFrames,
      evict: () => {
        // Only delete the map entry if it still points at this (now-empty) session.
        if (sessions.get(key) === session) {
          sessions.delete(key);
        }
      },
    });
    sessions.set(key, session);
    return session;
  };

  const server = http.createServer((req, res) => {
    const url = safeUrl(req.url);
    if (!url) {
      respond(res, 400, "Bad request");
      return;
    }
    if (url.pathname === "/health") {
      respond(res, 200, JSON.stringify({ status: "ok" }), "application/json");
      return;
    }
    if (url.pathname === "/ws") {
      respond(res, 426, "Expected WebSocket upgrade");
      return;
    }
    respond(res, 404, "Not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = safeUrl(req.url);
    if (!url) {
      refuse(socket, 400, "Bad request");
      return;
    }
    if (url.pathname !== "/ws") {
      refuse(socket, 404, "Not found");
      return;
    }

    const roleRaw = url.searchParams.get("role");
    const role: ConnectionRole | null =
      roleRaw === "server" || roleRaw === "client" ? roleRaw : null;
    const serverId = url.searchParams.get("serverId");
    const connectionIdRaw = url.searchParams.get("connectionId");
    const connectionId = typeof connectionIdRaw === "string" ? connectionIdRaw.trim() : "";
    const version = resolveRelayVersion(url.searchParams.get("v"));

    if (!role) {
      refuse(socket, 400, "Missing or invalid role parameter");
      return;
    }
    if (!serverId) {
      refuse(socket, 400, "Missing serverId parameter");
      return;
    }
    if (!version) {
      refuse(socket, 400, "Invalid v parameter (expected 1 or 2)");
      return;
    }

    const session = getOrCreateSession(version, serverId);
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      session.handleNewSocket(ws, role, connectionId);
    });
  });

  return server;
}

function safeUrl(input: string | undefined): URL | null {
  try {
    return new URL(input ?? "/", "http://relay-node.local");
  } catch {
    return null;
  }
}

function respond(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain",
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function refuse(socket: Duplex, status: number, message: string): void {
  const reason = http.STATUS_CODES[status] ?? "Error";
  const body = Buffer.from(message, "utf8");
  const head =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "content-type: text/plain\r\n" +
    `content-length: ${body.byteLength}\r\n` +
    "connection: close\r\n\r\n";
  socket.end(Buffer.concat([Buffer.from(head, "latin1"), body]));
}
