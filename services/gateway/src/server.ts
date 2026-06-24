/**
 * Stage 6 — runnable gateway: a WebSocket server (ws) that relays GatewayFrames onto real TCP
 * sockets (node:net), one RelaySession per connection, gated by the egress policy. DNS via
 * node:dns. This is the only file that touches I/O; the policy + relay logic it wires together
 * are pure and unit-tested separately.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import type { AddressInfo } from 'node:net';
import { RelaySession, type RelaySocket, type GatewayFrame } from './relay.js';
import type { GatewayEgressPolicy } from './egress.js';

export interface GatewayServerOptions {
  port: number;
  policy: GatewayEgressPolicy;
  authToken?: string; // when set, clients must present ?token=… (matched in constant-ish time)
  log?: (msg: string) => void;
}

export interface RunningGateway {
  port: number;
  close(): Promise<void>;
}

/** Wrap a node net.Socket as the RelaySocket the session expects. Connects to an already-vetted IP. */
function connectTcp(ip: string, port: number): RelaySocket {
  const sock = net.connect({ host: ip, port, family: ip.includes(':') ? 6 : 4 });
  let onData: (d: Uint8Array) => void = () => {};
  let onClose: () => void = () => {};
  let closed = false;
  const fireClose = (): void => {
    if (!closed) {
      closed = true;
      onClose();
    }
  };
  sock.on('data', (b) => onData(new Uint8Array(b)));
  sock.on('close', fireClose);
  sock.on('error', fireClose);
  return {
    write: (d) => sock.write(d),
    end: () => sock.end(),
    onData: (cb) => {
      onData = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
  };
}

/** Constant-time string compare (AUD-023) — avoids leaking the token via comparison timing. */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startGateway(opts: GatewayServerOptions): Promise<RunningGateway> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Cap the WebSocket frame so a single oversized message can't exhaust memory (AUD-023).
    const wss = new WebSocketServer({ port: opts.port, maxPayload: 256 * 1024 });
    // Reject (don't hang/timeout) when the listen fails — e.g. port in use / permission denied (AUD-023).
    wss.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    wss.on('connection', (ws: WebSocket, req) => {
      if (opts.authToken) {
        const url = new URL(req.url ?? '/', 'http://gateway.local');
        if (!tokenMatches(url.searchParams.get('token'), opts.authToken)) {
          opts.log?.('unauthorized connection rejected');
          ws.close(1008, 'unauthorized');
          return;
        }
      }
      const session = new RelaySession({
        policy: opts.policy,
        now: () => Date.now(),
        send: (frame) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
        },
        connect: connectTcp,
        resolve: async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address),
        log: opts.log,
        onExpire: () => ws.close(1000, 'session wall-clock exceeded'),
      });
      // Proactively reap an expired session even if it goes idle (no frame to trigger the per-frame
      // wall-clock check) — AUD-021. Cleared on close so the timer can't outlive the connection.
      const deadlineTimer = setInterval(() => session.enforceDeadline(), 1000);
      deadlineTimer.unref?.();
      ws.on('message', (raw) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(raw.toString()) as GatewayFrame;
        } catch {
          return; // ignore malformed frames
        }
        // Don't fire-and-forget: a rejected handle() would otherwise be an unhandled promise rejection.
        session.handle(frame).catch((e: unknown) => {
          opts.log?.(`session error: ${e instanceof Error ? e.message : String(e)}`);
          session.destroy();
        });
      });
      ws.on('close', () => {
        clearInterval(deadlineTimer);
        session.destroy();
      });
      ws.on('error', () => {
        clearInterval(deadlineTimer);
        session.destroy();
      });
    });
    wss.on('listening', () => {
      settled = true;
      const port = (wss.address() as AddressInfo).port;
      opts.log?.(`gateway listening on :${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}
