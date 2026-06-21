# relay-node: self-host the Paseo relay

Paseo's relay bridges the on-machine daemon to the phone/app over E2E-encrypted
WebSockets, so you can reach your agents remotely without opening any ports. The
hosted relay runs on Cloudflare (`relay.paseo.sh`), which is unreliable or
unreachable from some networks.

**`relay-node`** is a protocol-compatible Node.js implementation you can run on
any host that's reachable from your network — a VPS in the right region, a home
server, a cloud instance — behind a TLS-terminating reverse proxy. Point your
daemon and app at it instead of the Cloudflare relay.

The relay is **zero-knowledge**. relay-node forwards opaque, end-to-end-encrypted
bytes; it never sees plaintext. Running your own does not weaken the threat model
in [../SECURITY.md](../SECURITY.md) — it only changes _who operates the relay_,
not what the relay can do.

- Package: `packages/relay-node` (`@getpaseo/relay-node`)
- Ported from: `packages/relay/src/cloudflare-adapter.ts`
- Runtime dependency: `ws` only (no crypto, no database — the relay is stateless)

## Why a Node version

The Cloudflare relay is a Worker + Durable Object. Self-hosting it requires a
Cloudflare account and depends on the Cloudflare network, which is the exact
thing that's blocked. relay-node is a single Node process you run anywhere.

## What it is (and isn't)

- **Stateless.** Like the Cloudflare relay, it holds only live WebSocket
  connections in memory. There is no SQLite and nothing to back up. Restarting it
  just makes everyone reconnect.
- **Plain `ws` only.** It does not terminate TLS. Put nginx or Caddy in front.
  (The daemon/app choose `ws` vs `wss` from the relay endpoint's `useTls` flag.)
- **Not a dependency of the daemon.** The server doesn't import it; it's a
  standalone deployable. The daemon already speaks the relay wire protocol, so no
  daemon or app code changes are needed to use it.

## Run it

### From source (monorepo)

```bash
npm install
npm run build --workspace=@getpaseo/relay-node
npm start --workspace=@getpaseo/relay-node
# -> [relay-node] listening on ws://0.0.0.0:8080/ws
```

Dev mode with auto-reload:

```bash
npm run dev --workspace=@getpaseo/relay-node
```

### Docker

```bash
docker compose -f packages/relay-node/docker-compose.yml up --build
```

## Configuration

All flags have an environment-variable equivalent (env wins by default; the CLI
flag wins over env).

| Flag                   | Default   | Env                  | Meaning                                                     |
| ---------------------- | --------- | -------------------- | ----------------------------------------------------------- |
| `--host`               | `0.0.0.0` | `HOST`               | Listen address. Behind a reverse proxy, leave as `0.0.0.0`. |
| `--port`               | `8080`    | `PORT`               | Listen port.                                                |
| `--log-level`          | `info`    | `LOG_LEVEL`          | `debug` / `info` / `warn` / `error`.                        |
| `--max-pending-frames` | `200`     | `MAX_PENDING_FRAMES` | Per-connection frame buffer cap before the daemon attaches. |

## Terminate TLS with a reverse proxy

relay-node listens on plain `ws`. Expose it as `wss://your-relay.example.com/ws`
through a reverse proxy that terminates TLS and upgrades WebSockets.

### Caddy (auto-HTTPS, simplest)

```caddyfile
your-relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy handles certificates (Let's Encrypt) and WebSocket upgrades automatically.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name your-relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/your-relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;   # keep idle relay sockets open
        proxy_send_timeout 3600s;
    }
}
```

## Point your daemon and app at it

The daemon's relay settings live in `$PASEO_HOME/config.json` (default
`~/.paseo/config.json`) under `daemon.relay`, or in env vars:

```jsonc
{
  "daemon": {
    "relay": {
      "endpoint": "your-relay.example.com:443",
      "useTls": true,
    },
  },
}
```

Equivalent env vars (handy for containers):

```bash
PASEO_RELAY_ENDPOINT=your-relay.example.com:443
PASEO_RELAY_USE_TLS=true
```

- `endpoint` is `host:port` of your public relay address (the reverse proxy).
- `useTls=true` because clients reach it over `wss://`.
- `publicEndpoint` / `publicUseTls` override the client-facing URL independently
  if your daemon-to-relay and client-to-relay paths differ.

Re-pair the app (the pairing QR carries the daemon's public key — the trust
anchor — plus the relay endpoint), then connect. The handshake and all traffic
flow through relay-node exactly as they would through the Cloudflare relay.

## Wire contract (parity with the Cloudflare relay)

```
GET  /health                                              -> {"status":"ok"}
WS   /ws?serverId=&role=server|client&v=1|2&connectionId=
```

- **v1** (legacy): one server socket + one client socket per session, naive
  cross-forward.
- **v2** (current): a daemon **control** socket (`role=server`, no `connectionId`)
  receives `{type:"sync"|"connected"|"disconnected"}` control frames; the daemon
  opens one **data** socket per `connectionId`; clients connect per
  `connectionId`. The relay buffers up to `max-pending-frames` client frames until
  the matching data socket opens.

The URL is built by `packages/protocol/src/daemon-endpoints.ts`
(`buildRelayWebSocketUrl`); relay-node parses the same query params. Close codes
match the Cloudflare implementation (e.g. `1008` replaced, `1001` client left,
`1011` control unresponsive, `1012` server left).

## Troubleshooting

- **Can't connect:** confirm the reverse proxy is up, TLS is valid, and the
  proxy forwards `Upgrade`/`Connection` headers (nginx) or uses `reverse_proxy`
  (Caddy). `curl https://your-relay.example.com/health` should return
  `{"status":"ok"}`.
- **Handshake fails / no traffic:** the relay only carries bytes — if the E2EE
  handshake fails, the issue is on the daemon/app side (keypair, pairing offer),
  not the relay. Check the daemon log at `$PASEO_HOME/daemon.log`.
- **Wrong TLS:** remember the daemon uses `useTls` to pick `ws` vs `wss`. If you
  exposed plain `ws` (no proxy), set `daemon.relay.useTls=false` and a non-443
  port — but don't send traffic over the open internet unencrypted.
- **Logs:** run with `--log-level debug` to see connect/disconnect/control events
  per session.

## Development

```bash
npm run typecheck --workspace=@getpaseo/relay-node
npm run lint -- packages/relay-node
npm run format
npx vitest run packages/relay-node/src/relay-server.test.ts --bail=1
```

Tests spin up the real server on an ephemeral port and exercise it with real
`ws` clients (see [testing.md](testing.md)) — they double as the parity check
against the Cloudflare relay.
