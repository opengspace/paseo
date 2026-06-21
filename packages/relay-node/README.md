# @getpaseo/relay-node

A self-hostable, protocol-compatible **Node.js relay** for Paseo — a drop-in
alternative to the hosted Cloudflare relay (`relay.paseo.sh`). Run it on any host
that's reachable from your network (e.g. a VPS) and point your
daemon and app at it instead of the Cloudflare relay.

The relay is **zero-knowledge**: it forwards opaque, end-to-end-encrypted bytes
between your daemon and your phone. It cannot read your traffic. See
[SECURITY.md](../../SECURITY.md) — relay-node does not change that threat model.

> Full deployment guide (reverse-proxy TLS, config reference, troubleshooting):
> [docs/relay-node.md](../../docs/relay-node.md)

## Quick start

```bash
# from the repo root
npm install
npm run build --workspace=@getpaseo/relay-node
npm start --workspace=@getpaseo/relay-node
# -> listening on ws://0.0.0.0:8080/ws
```

Or with Docker:

```bash
docker compose -f packages/relay-node/docker-compose.yml up --build
```

## CLI / environment

| Flag                   | Default   | Env                  |
| ---------------------- | --------- | -------------------- |
| `--host`               | `0.0.0.0` | `HOST`               |
| `--port`               | `8080`    | `PORT`               |
| `--log-level`          | `info`    | `LOG_LEVEL`          |
| `--max-pending-frames` | `200`     | `MAX_PENDING_FRAMES` |

## Pointing Paseo at your relay

Put a TLS-terminating reverse proxy (nginx/caddy) in front, exposing
`wss://your-relay.example.com/ws`. Then point the daemon at it via `config.json`
(`$PASEO_HOME/config.json`) or env vars:

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

Equivalent env vars: `PASEO_RELAY_ENDPOINT=your-relay.example.com:443` and
`PASEO_RELAY_USE_TLS=true`. The daemon and app build the WebSocket URL from the
endpoint and pick `ws`/`wss` based on `useTls` — no Paseo code changes are needed.
See [docs/relay-node.md](../../docs/relay-node.md) for the full guide.

## Wire contract

Identical to the Cloudflare relay (`packages/relay`):

```
GET  /health                                              -> {"status":"ok"}
WS   /ws?serverId=&role=server|client&v=1|2&connectionId=
```

Protocol versions: `v1` (single server/client pair) and `v2` (control +
per-connection data sockets). relay-node implements both.
