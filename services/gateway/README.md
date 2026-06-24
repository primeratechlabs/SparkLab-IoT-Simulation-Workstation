# Sparklab Tier-3 Gateway

A minimal **WebSocket ↔ raw TCP/TLS relay** so a browser-run firmware sketch can reach services it
otherwise can't: TCP-only MQTT brokers (`:1883`/`:8883`), non-CORS HTTP, or any raw TCP/TLS endpoint.
**TLS terminates in the firmware** — the gateway relays opaque bytes and never sees plaintext.

It is **optional**. Most teaching cases need no gateway (MQTT over WebSocket + CORS HTTP connect
directly — see the app's Network Lab). You only need this for TCP-only / non-CORS endpoints.

> It does **not** compile anything (`backend_compile_count` stays 0) and stores nothing. It is a
> thin, stateless relay — keep it that way (doctrine: "backend ≈ 0").

## ⚠ Security first

The relay opens real sockets on behalf of clients, so an unguarded one is an **open proxy / SSRF**
vector (it could reach your host's internal network or the cloud metadata endpoint
`169.254.169.254` → credential theft). Hardening is ON by default and enforced + tested
(`src/egress.test.ts`, `src/relay.test.ts`):

- **Default-deny allowlist** (`GATEWAY_ALLOWLIST`) — empty reaches nothing.
- **Private/reserved IP blocking** — RFC1918, loopback, link-local, **metadata**, CGNAT, multicast (v4 + v6).
- **DNS-rebind protection** — resolve, vet the IP, connect to _that_ IP.
- **Per-session caps** — max connections, connection rate, bandwidth, wall-clock; **session isolation**.
- **Auth token** (`GATEWAY_TOKEN`).

Never set `GATEWAY_ALLOW_PRIVATE=1` in production. Keep the allowlist tight (only the brokers/APIs
you teach with). A public gateway carries abuse/legal exposure on your IP.

## Run locally (no cloud)

```bash
cp services/gateway/.env.example services/gateway/.env   # edit allowlist + token
pnpm --filter @sparklab/gateway start                    # → ws://127.0.0.1:9000
```

## Deploy on your VPS

```bash
cp .env.example .env && $EDITOR .env        # set GATEWAY_ALLOWLIST + a long GATEWAY_TOKEN
docker compose up -d                        # gateway on 127.0.0.1:9000
```

Front it with a TLS-terminating reverse proxy so the browser uses `wss://` (required on an HTTPS page):

**Caddy** (`Caddyfile`):

```
gw.your-domain.example {
    reverse_proxy 127.0.0.1:9000
}
```

**nginx**:

```nginx
location /gateway {
    proxy_pass http://127.0.0.1:9000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Then point the app at it: in `packages/app/.env` set
`VITE_GATEWAY_WS_URL=wss://gw.your-domain.example/?token=<your-token>`.

## Protocol

`GatewayFrame` (JSON over the WS), defined in `services/gateway/src/relay.ts`:

```ts
{ t: 'open',  id, proto: 'tcp', host, port }   // client → gateway
{ t: 'data',  id, b: number[] }                // both ways (opaque bytes, e.g. TLS records)
{ t: 'close', id }                             // both ways
```

The browser client is `Tier3GatewayClient` in `@sparklab/network-shim`.

## Config (env)

| Var                       | Default            | Meaning                                          |
| ------------------------- | ------------------ | ------------------------------------------------ |
| `GATEWAY_PORT`            | 9000               | listen port                                      |
| `GATEWAY_ALLOWLIST`       | (empty = deny all) | comma-separated hosts / `*.suffix`               |
| `GATEWAY_TOKEN`           | (none)             | required `?token=` for clients                   |
| `GATEWAY_MAX_CONNS`       | 8                  | max concurrent conns / session                   |
| `GATEWAY_CONN_RATE`       | 5                  | new conns / second / session                     |
| `GATEWAY_BANDWIDTH`       | 1000000            | bytes / second / session                         |
| `GATEWAY_SESSION_SECONDS` | 600                | session wall-clock budget                        |
| `GATEWAY_ALLOW_PRIVATE`   | (unset)            | `1` disables private-IP blocking — **dangerous** |
