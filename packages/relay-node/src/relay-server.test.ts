/**
 * relay-node integration tests.
 *
 * Spins up the real server on an ephemeral port and exercises it with real `ws`
 * clients (real-deps-over-mocks, per docs/testing.md). These double as the
 * drop-in-parity check against packages/relay/src/cloudflare-adapter.ts.
 *
 * Note on capture timing: the v2 relay sends some frames immediately on connect
 * (the control `sync`, `connected` notifications, the legacy `pong`). A test that
 * registers its message listener only after `await open` would miss those frames
 * when they arrive in the same data pass as the handshake. The `connect()` helper
 * therefore attaches a capturing listener at socket-creation time and serves
 * `nextMessage` from a queue, so server-initiated frames are never lost.
 */

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer } from "./relay-server.js";

interface RelayHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

const relays: RelayHandle[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  // Tear down clients first so server.close() doesn't wait on lingering sockets.
  for (const ws of sockets) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }
  sockets.length = 0;
  await Promise.all(relays.map((r) => r.close()));
  relays.length = 0;
});

async function startRelay(): Promise<RelayHandle> {
  const server = createRelayServer({ maxPendingFrames: 200 });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const handle: RelayHandle = {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  relays.push(handle);
  return handle;
}

function wsUrl(port: number, query: Record<string, string | undefined>): string {
  const url = new URL(`ws://127.0.0.1:${port}/ws`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

interface Peer {
  ws: WebSocket;
  nextMessage: (timeoutMs?: number) => Promise<string>;
  waitForClose: (timeoutMs?: number) => Promise<number>;
}

/** Connects and resolves once open, capturing every message from creation. */
function connect(url: string): Promise<Peer> {
  const ws = new WebSocket(url);
  sockets.push(ws);

  const queue: string[] = [];
  const messageWaiters: Array<(msg: string) => void> = [];
  let closedCode: number | null = null;
  const closeWaiters: Array<(code: number) => void> = [];

  ws.on("message", (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const waiter = messageWaiters.shift();
    if (waiter) waiter(text);
    else queue.push(text);
  });
  ws.on("close", (code) => {
    closedCode = code;
    const waiter = closeWaiters.shift();
    if (waiter) waiter(code);
  });

  return new Promise<Peer>((resolve, reject) => {
    ws.once("open", () =>
      resolve({
        ws,
        nextMessage: (timeoutMs = 2000) => {
          if (queue.length > 0) return Promise.resolve(queue.shift() as string);
          return new Promise<string>((resolveMsg, rejectMsg) => {
            const timer = setTimeout(() => rejectMsg(new Error("message timeout")), timeoutMs);
            messageWaiters.push((msg) => {
              clearTimeout(timer);
              resolveMsg(msg);
            });
          });
        },
        waitForClose: (timeoutMs = 2000) => {
          if (closedCode !== null) return Promise.resolve(closedCode);
          return new Promise<number>((resolveClose, rejectClose) => {
            const timer = setTimeout(() => rejectClose(new Error("close timeout")), timeoutMs);
            closeWaiters.push((code) => {
              clearTimeout(timer);
              resolveClose(code);
            });
          });
        },
      }),
    );
    ws.once("error", reject);
  });
}

function closePeers(peers: Peer[]): Promise<void> {
  return Promise.all(
    peers.map(
      (peer) =>
        new Promise<void>((resolve) => {
          if (peer.ws.readyState === WebSocket.CLOSED) return resolve();
          peer.ws.once("close", () => resolve());
          peer.ws.close();
        }),
    ),
  ).then(() => undefined);
}

describe("relay-node http", () => {
  it("GET /health returns { status: 'ok' }", async () => {
    const relay = await startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("unknown path returns 404", async () => {
    const relay = await startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/nope`);
    expect(res.status).toBe(404);
  });

  it("GET /ws without an upgrade returns 426", async () => {
    const relay = await startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/ws?serverId=x&role=client&v=2`);
    expect(res.status).toBe(426);
  });
});

describe("relay-node upgrade validation", () => {
  it("refuses an upgrade missing serverId (400)", async () => {
    const relay = await startRelay();
    await expect(connect(wsUrl(relay.port, { role: "client", v: "2" }))).rejects.toBeDefined();
  });

  it("refuses an upgrade with an invalid role (400)", async () => {
    const relay = await startRelay();
    await expect(
      connect(wsUrl(relay.port, { serverId: "s", role: "bogus", v: "2" })),
    ).rejects.toBeDefined();
  });

  it("refuses an upgrade with an invalid version (400)", async () => {
    const relay = await startRelay();
    await expect(
      connect(wsUrl(relay.port, { serverId: "s", role: "client", v: "9" })),
    ).rejects.toBeDefined();
  });
});

describe("relay-node v1", () => {
  it("forwards a message from server to client", async () => {
    const relay = await startRelay();
    const server = await connect(wsUrl(relay.port, { serverId: "v1", role: "server", v: "1" }));
    const client = await connect(wsUrl(relay.port, { serverId: "v1", role: "client", v: "1" }));

    const received = client.nextMessage();
    server.ws.send("hello-from-server");
    expect(await received).toBe("hello-from-server");

    await closePeers([server, client]);
  });
});

describe("relay-node v2", () => {
  it("sends an initial sync to the control socket", async () => {
    const relay = await startRelay();
    const control = await connect(wsUrl(relay.port, { serverId: "c1", role: "server", v: "2" }));
    const sync = JSON.parse(await control.nextMessage());
    expect(sync).toEqual({ type: "sync", connectionIds: [] });
    await closePeers([control]);
  });

  it("notifies control on client connect and forwards once the data socket opens", async () => {
    const relay = await startRelay();
    const control = await connect(wsUrl(relay.port, { serverId: "h1", role: "server", v: "2" }));
    await control.nextMessage(); // consume initial sync

    const client = await connect(wsUrl(relay.port, { serverId: "h1", role: "client", v: "2" }));
    const connected = JSON.parse(await control.nextMessage());
    expect(connected.type).toBe("connected");
    expect(typeof connected.connectionId).toBe("string");
    const connectionId: string = connected.connectionId;

    const data = await connect(
      wsUrl(relay.port, { serverId: "h1", role: "server", v: "2", connectionId }),
    );

    const serverGot = data.nextMessage();
    client.ws.send("ping");
    expect(await serverGot).toBe("ping");

    const clientGot = client.nextMessage();
    data.ws.send("pong");
    expect(await clientGot).toBe("pong");

    await closePeers([client, data, control]);
  });

  it("buffers client frames until the data socket opens, then flushes in order", async () => {
    const relay = await startRelay();
    const control = await connect(wsUrl(relay.port, { serverId: "b1", role: "server", v: "2" }));
    await control.nextMessage();

    const client = await connect(wsUrl(relay.port, { serverId: "b1", role: "client", v: "2" }));
    const connected = JSON.parse(await control.nextMessage());
    const connectionId: string = connected.connectionId;

    // Sent before any server-data socket exists — must be buffered.
    client.ws.send("buffered-1");
    client.ws.send("buffered-2");

    const data = await connect(
      wsUrl(relay.port, { serverId: "b1", role: "server", v: "2", connectionId }),
    );
    expect(await data.nextMessage()).toBe("buffered-1");
    expect(await data.nextMessage()).toBe("buffered-2");

    await closePeers([client, data, control]);
  });

  it("closes the server-data socket (1001) and notifies disconnected when the client leaves", async () => {
    const relay = await startRelay();
    const control = await connect(wsUrl(relay.port, { serverId: "d1", role: "server", v: "2" }));
    await control.nextMessage();

    const client = await connect(wsUrl(relay.port, { serverId: "d1", role: "client", v: "2" }));
    const connected = JSON.parse(await control.nextMessage());
    const connectionId: string = connected.connectionId;
    const data = await connect(
      wsUrl(relay.port, { serverId: "d1", role: "server", v: "2", connectionId }),
    );

    const dataClosed = data.waitForClose();
    const controlNext = control.nextMessage();

    client.ws.close();

    expect(await dataClosed).toBe(1001);
    expect(JSON.parse(await controlNext)).toEqual({
      type: "disconnected",
      connectionId,
    });

    await closePeers([control]);
  });

  it("echoes pong for the legacy JSON ping on the control channel", async () => {
    const relay = await startRelay();
    const control = await connect(wsUrl(relay.port, { serverId: "p1", role: "server", v: "2" }));
    await control.nextMessage(); // consume initial sync

    control.ws.send(JSON.stringify({ type: "ping" }));
    const pong = JSON.parse(await control.nextMessage());
    expect(pong.type).toBe("pong");
    expect(typeof pong.ts).toBe("number");

    await closePeers([control]);
  });

  it("replaces a prior control socket when a new one connects (1008)", async () => {
    const relay = await startRelay();
    const first = await connect(wsUrl(relay.port, { serverId: "r1", role: "server", v: "2" }));
    await first.nextMessage();

    const firstClosed = first.waitForClose();
    const second = await connect(wsUrl(relay.port, { serverId: "r1", role: "server", v: "2" }));
    await second.nextMessage(); // new control's sync

    expect(await firstClosed).toBe(1008);
    await closePeers([second]);
  });
});
