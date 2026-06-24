import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { WebSocket } from 'ws';
import { startGateway } from './server.js';
import { DEFAULT_POLICY } from './egress.js';
import type { GatewayFrame } from './relay.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  for (let i = 0; i < ms / 25; i++) {
    if (pred()) return true;
    await delay(25);
  }
  return pred();
}

/** A local TCP echo server (the "internet service" the gateway relays to). */
function startEcho(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.pipe(sock));
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((res) => srv.close(() => res())) });
    });
  });
}

function openClient(port: number, token?: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${token ? `?token=${token}` : ''}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe('gateway server — WS↔TCP relay integration', () => {
  it('relays open/data/close to a real TCP service and echoes the bytes back', async () => {
    const echo = await startEcho();
    const gw = await startGateway({
      port: 0,
      policy: { ...DEFAULT_POLICY, allowlist: ['127.0.0.1'], denyPrivateRanges: false },
    });
    const ws = await openClient(gw.port);
    const frames: GatewayFrame[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as GatewayFrame));

    ws.send(JSON.stringify({ t: 'open', id: 1, proto: 'tcp', host: '127.0.0.1', port: echo.port }));
    await delay(100);
    ws.send(JSON.stringify({ t: 'data', id: 1, b: [...Buffer.from('ping')] }));

    const got = await waitFor(() =>
      frames.some(
        (f) => f.t === 'data' && Buffer.from((f as { b: number[] }).b).toString() === 'ping',
      ),
    );
    expect(got).toBe(true);

    ws.send(JSON.stringify({ t: 'close', id: 1 }));
    ws.close();
    await gw.close();
    await echo.close();
  });

  it('refuses a private/reserved target when denyPrivateRanges is on (close frame, no relay)', async () => {
    const echo = await startEcho();
    const gw = await startGateway({
      port: 0,
      policy: { ...DEFAULT_POLICY, allowlist: ['127.0.0.1'], denyPrivateRanges: true },
    });
    const ws = await openClient(gw.port);
    const frames: GatewayFrame[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as GatewayFrame));

    ws.send(JSON.stringify({ t: 'open', id: 1, proto: 'tcp', host: '127.0.0.1', port: echo.port }));
    const closed = await waitFor(() => frames.some((f) => f.t === 'close' && f.id === 1));
    expect(closed).toBe(true);
    expect(frames.some((f) => f.t === 'data')).toBe(false); // nothing was relayed

    ws.close();
    await gw.close();
    await echo.close();
  });

  it('rejects an unauthorized client when a token is required', async () => {
    const gw = await startGateway({
      port: 0,
      policy: { ...DEFAULT_POLICY, allowlist: ['*'] },
      authToken: 'secret',
    });
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}`); // no token
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => resolve(-1));
    });
    expect(code).toBe(1008);
    await gw.close();
  });
});
