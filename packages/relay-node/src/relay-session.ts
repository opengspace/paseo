/**
 * Per-session relay state — a faithful 1:1 port of the Cloudflare
 * `RelayDurableObject` (packages/relay/src/cloudflare-adapter.ts).
 *
 * One RelaySession exists per `relay-v${version}:${serverId}`. It owns the
 * tagged-socket index (replacing the Durable Object hibernation API) and the
 * per-connectionId frame buffer. The relay is zero-knowledge: it only forwards
 * opaque bytes and the plaintext control handshake frames.
 *
 * v1: one server socket + one client socket per session, naive cross-forward.
 * v2:
 *   - role=server, no connectionId  -> daemon control socket (one per serverId)
 *   - role=server + connectionId    -> daemon per-connection data socket
 *   - role=client + connectionId    -> app/client socket (many per connectionId)
 */

import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { TaggedSocketIndex } from "./tagged-sockets.js";
import type { ConnectionRole, RelaySessionAttachment } from "./types.js";
import { LEGACY_RELAY_VERSION } from "./version.js";
import type { Logger } from "./logger.js";

interface BufferedFrame {
  payload: Buffer;
  isBinary: boolean;
}

export interface RelaySessionDeps {
  version: "1" | "2";
  serverId: string;
  logger: Logger;
  maxPendingFrames: number;
  /** Invoked once the session holds zero sockets, so the server can drop it. */
  evict: () => void;
}

export class RelaySession {
  private readonly tags = new TaggedSocketIndex();
  private readonly pendingFrames = new Map<string, BufferedFrame[]>();
  private readonly attachments = new WeakMap<WebSocket, RelaySessionAttachment>();
  private evicted = false;

  constructor(private readonly deps: RelaySessionDeps) {}

  /**
   * Called by the server once a WebSocket upgrade completes. Branches into the
   * v1 or v2 connect flow based on the session's protocol version.
   */
  handleNewSocket(ws: WebSocket, role: ConnectionRole, connectionId: string): void {
    if (this.deps.version === LEGACY_RELAY_VERSION) {
      this.connectV1(ws, role);
      return;
    }
    this.connectV2(ws, role, connectionId);
  }

  // --- connect flows (ports of fetchV1 / fetchV2) ---

  private connectV1(ws: WebSocket, role: ConnectionRole): void {
    for (const existing of this.tags.get(role)) {
      safeClose(existing, 1008, "Replaced by new connection");
    }

    this.attach(ws, [role], {
      serverId: this.deps.serverId,
      role,
      version: "1",
      connectionId: null,
      createdAt: Date.now(),
    });

    this.deps.logger.info(`v1:${role} connected to session ${this.deps.serverId}`);
  }

  private connectV2(ws: WebSocket, role: ConnectionRole, connectionId: string): void {
    // If a client didn't provide a connectionId, the relay assigns one for routing.
    const resolvedConnectionId =
      role === "client" && !connectionId
        ? `conn_${randomUUID().replace(/-/g, "").slice(0, 16)}`
        : connectionId;

    const isServerControl = role === "server" && !resolvedConnectionId;
    const isServerData = role === "server" && !!resolvedConnectionId;

    // Close any existing server-side connection with the same identity.
    this.closeExistingServerSockets({ isServerControl, isServerData, resolvedConnectionId });

    const tags: string[] = [];
    if (role === "client") {
      tags.push("client", `client:${resolvedConnectionId}`);
    } else if (isServerControl) {
      tags.push("server-control");
    } else {
      tags.push("server", `server:${resolvedConnectionId}`);
    }

    this.attach(ws, tags, {
      serverId: this.deps.serverId,
      role,
      version: "2",
      connectionId: resolvedConnectionId || null,
      createdAt: Date.now(),
    });

    let roleSuffix = "";
    if (isServerControl) {
      roleSuffix = "(control)";
    } else if (isServerData) {
      roleSuffix = `(data:${resolvedConnectionId})`;
    } else if (role === "client") {
      roleSuffix = `(${resolvedConnectionId})`;
    }
    this.deps.logger.info(`v2:${role}${roleSuffix} connected to session ${this.deps.serverId}`);

    if (role === "client") {
      this.notifyControls({ type: "connected", connectionId: resolvedConnectionId });
      this.nudgeOrResetControlForConnection(resolvedConnectionId);
    }

    if (isServerControl) {
      // Send current connection list so the daemon can attach existing connections.
      const sync = JSON.stringify({
        type: "sync",
        connectionIds: this.listConnectedConnectionIds(),
      });
      safeSend(ws, Buffer.from(sync), false);
    }

    if (isServerData && resolvedConnectionId) {
      this.flushFrames(resolvedConnectionId, ws);
    }
  }

  private attach(ws: WebSocket, tags: string[], attachment: RelaySessionAttachment): void {
    this.tags.add(ws, tags);
    this.attachments.set(ws, attachment);
    ws.on("message", (data, isBinary) => this.onMessage(ws, data, isBinary));
    ws.on("close", (code, reason) => this.onClose(ws, code, reason));
    ws.on("error", (error) => this.onError(ws, error));
  }

  // --- message / close / error (ports of webSocketMessage/Close/Error) ---

  private onMessage(ws: WebSocket, data: RawData, isBinary: boolean): void {
    const attachment = this.attachments.get(ws);
    if (!attachment) {
      this.deps.logger.error("Message from WebSocket without attachment");
      return;
    }

    if (attachment.version === LEGACY_RELAY_VERSION) {
      const payload = toBuffer(data);
      const targetRole: ConnectionRole = attachment.role === "server" ? "client" : "server";
      for (const target of this.tags.get(targetRole)) {
        if (!safeSend(target, payload, isBinary)) {
          this.deps.logger.error(`Failed to forward to ${targetRole}`);
        }
      }
      return;
    }

    const connectionId = attachment.connectionId;
    if (!connectionId) {
      // Control channel: support the legacy app-level keepalive only.
      if (!isBinary) {
        this.handleControlKeepalive(ws, data);
      }
      return;
    }

    const payload = toBuffer(data);

    if (attachment.role === "client") {
      const servers = this.tags.get(`server:${connectionId}`);
      if (servers.length === 0) {
        this.bufferFrame(connectionId, payload, isBinary);
        return;
      }
      for (const target of servers) {
        if (!safeSend(target, payload, isBinary)) {
          this.deps.logger.error(`Failed to forward client->server(${connectionId})`);
        }
      }
      return;
    }

    // server data socket -> client
    for (const target of this.tags.get(`client:${connectionId}`)) {
      if (!safeSend(target, payload, isBinary)) {
        this.deps.logger.error(`Failed to forward server->client(${connectionId})`);
      }
    }
  }

  private onClose(ws: WebSocket, code: number, reason: Buffer): void {
    const attachment = this.attachments.get(ws);
    this.tags.remove(ws);

    if (!attachment) {
      this.maybeEvict();
      return;
    }

    const version = attachment.version;
    const role = attachment.role;
    const connectionId = attachment.connectionId ?? null;
    this.deps.logger.info(
      `v${version}:${role}${connectionId ? `(${connectionId})` : ""} disconnected from session ${this.deps.serverId} (${code}: ${reason.toString()})`,
    );

    if (version === LEGACY_RELAY_VERSION) {
      this.maybeEvict();
      return;
    }

    if (role === "client" && connectionId) {
      if (this.tags.get(`client:${connectionId}`).length > 0) {
        // Other client sockets for this session are still open.
        this.maybeEvict();
        return;
      }

      this.pendingFrames.delete(connectionId);
      // Last socket for this session closed: clean up matching server-data socket.
      for (const serverWs of this.tags.get(`server:${connectionId}`)) {
        safeClose(serverWs, 1001, "Client disconnected");
      }
      this.notifyControls({ type: "disconnected", connectionId });
      this.maybeEvict();
      return;
    }

    if (role === "server" && connectionId) {
      // Force the client to reconnect and re-handshake when the daemon side drops.
      for (const clientWs of this.tags.get(`client:${connectionId}`)) {
        safeClose(clientWs, 1012, "Server disconnected");
      }
      this.maybeEvict();
      return;
    }

    this.maybeEvict();
  }

  private onError(ws: WebSocket, error: unknown): void {
    const attachment = this.attachments.get(ws);
    const role = attachment?.role ?? "unknown";
    this.deps.logger.error(`WebSocket error for ${role}`, error);
  }

  // --- helpers (ports of the private DO methods) ---

  // COMPAT(relay-json-ping): Old daemons (< v0.1.76) send JSON {type:"ping"} on the
  // control socket and rely on a JSON {type:"pong"} reply. New daemons use
  // WebSocket protocol pings. Remove once the daemon floor is >= v0.1.76.
  private handleControlKeepalive(ws: WebSocket, data: RawData): void {
    try {
      const parsed: unknown = JSON.parse(toBuffer(data).toString("utf8"));
      if (isRecord(parsed) && parsed.type === "ping") {
        this.deps.logger.debug("legacy_json_ping_received");
        safeSend(ws, Buffer.from(JSON.stringify({ type: "pong", ts: Date.now() })), false);
      }
    } catch {
      // ignore non-JSON control payloads
    }
  }

  private nudgeOrResetControlForConnection(connectionId: string): void {
    // If the daemon's control WS is half-open, observe whether it reacts by
    // opening the per-connection server-data socket. If not, nudge with a sync;
    // if still no reaction, force-close the control socket(s) so it reconnects.
    const initialDelayMs = 10_000;
    const secondDelayMs = 5_000;

    setTimeout(() => {
      if (!this.hasClientSocket(connectionId)) return;
      if (this.hasServerDataSocket(connectionId)) return;

      this.notifyControls({ type: "sync", connectionIds: this.listConnectedConnectionIds() });

      setTimeout(() => {
        if (!this.hasClientSocket(connectionId)) return;
        if (this.hasServerDataSocket(connectionId)) return;

        for (const ws of this.tags.get("server-control")) {
          safeClose(ws, 1011, "Control unresponsive");
        }
      }, secondDelayMs).unref();
    }, initialDelayMs).unref();
  }

  private closeExistingServerSockets(args: {
    isServerControl: boolean;
    isServerData: boolean;
    resolvedConnectionId: string;
  }): void {
    if (args.isServerControl) {
      for (const ws of this.tags.get("server-control")) {
        safeClose(ws, 1008, "Replaced by new connection");
      }
    } else if (args.isServerData) {
      for (const ws of this.tags.get(`server:${args.resolvedConnectionId}`)) {
        safeClose(ws, 1008, "Replaced by new connection");
      }
    }
  }

  private bufferFrame(connectionId: string, payload: Buffer, isBinary: boolean): void {
    const existing = this.pendingFrames.get(connectionId) ?? [];
    existing.push({ payload, isBinary });
    // Prevent unbounded memory growth if a daemon never connects.
    if (existing.length > this.deps.maxPendingFrames) {
      existing.splice(0, existing.length - this.deps.maxPendingFrames);
    }
    this.pendingFrames.set(connectionId, existing);
  }

  private flushFrames(connectionId: string, ws: WebSocket): void {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames || frames.length === 0) return;

    for (let i = 0; i < frames.length; i += 1) {
      if (!safeSend(ws, frames[i].payload, frames[i].isBinary)) {
        // If we can't flush, re-buffer from the failed frame and let the daemon
        // re-establish.
        this.pendingFrames.set(connectionId, frames.slice(i));
        return;
      }
    }
    this.pendingFrames.delete(connectionId);
  }

  private listConnectedConnectionIds(): string[] {
    const out = new Set<string>();
    for (const ws of this.tags.get("client")) {
      const attachment = this.attachments.get(ws);
      if (
        attachment?.role === "client" &&
        typeof attachment.connectionId === "string" &&
        attachment.connectionId
      ) {
        out.add(attachment.connectionId);
      }
    }
    return Array.from(out);
  }

  private notifyControls(message: unknown): void {
    const payload = Buffer.from(JSON.stringify(message));
    for (const ws of this.tags.get("server-control")) {
      if (!safeSend(ws, payload, false)) {
        // If the control socket is dead, close it so the daemon can reconnect.
        safeClose(ws, 1011, "Control send failed");
      }
    }
  }

  private hasClientSocket(connectionId: string): boolean {
    return this.tags.has(`client:${connectionId}`);
  }

  private hasServerDataSocket(connectionId: string): boolean {
    return this.tags.has(`server:${connectionId}`);
  }

  private maybeEvict(): void {
    if (this.evicted || this.tags.size > 0) return;
    this.evicted = true;
    this.deps.logger.debug(`session evicted: relay-v${this.deps.version}:${this.deps.serverId}`);
    this.deps.evict();
  }
}

// --- shared utilities ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeSend(ws: WebSocket, payload: Buffer, isBinary: boolean): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(payload, { binary: isBinary });
    return true;
  } catch {
    return false;
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // ignore
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}
