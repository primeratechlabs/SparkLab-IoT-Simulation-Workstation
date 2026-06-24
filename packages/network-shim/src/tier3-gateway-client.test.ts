import { describe, it, expect } from 'vitest';
import { Tier3GatewayClient } from './tier3-gateway-client.js';
import { type WebSocketLike } from './tier2-mqtt.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A mock gateway: echoes any 'data' back on the same id (as if the relayed TCP service echoed). */
class MockGateway implements WebSocketLike {
  readyState = 1;
  binaryType = 'arraybuffer';
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readonly opened: { id: number; host: string; port: number }[] = [];
  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  send(d: Uint8Array): void {
    const f = JSON.parse(dec.decode(d)) as {
      t: string;
      id: number;
      b?: number[];
      host?: string;
      port?: number;
    };
    if (f.t === 'open') this.opened.push({ id: f.id, host: f.host!, port: f.port! });
    else if (f.t === 'data') this.reply({ t: 'data', id: f.id, b: f.b });
    else if (f.t === 'close') this.reply({ t: 'close', id: f.id });
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** simulate the relayed service closing the connection */
  remoteClose(id: number): void {
    this.reply({ t: 'close', id });
  }
  private reply(frame: unknown): void {
    const b = enc.encode(JSON.stringify(frame));
    queueMicrotask(() => this.onmessage?.({ data: b.buffer }));
  }
}

describe('tier3-gateway-client — Tier3GatewayClient over a mock gateway', () => {
  it('connects, opens a virtual TCP socket, and round-trips data', async () => {
    const gw = new MockGateway();
    const client = new Tier3GatewayClient({ url: 'wss://gw', token: 't', wsFactory: () => gw });
    await client.connect();
    expect(client.isConnected()).toBe(true);

    const sock = client.openTcp('broker.emqx.io', 1883);
    expect(gw.opened).toEqual([{ id: 1, host: 'broker.emqx.io', port: 1883 }]);

    const got: number[][] = [];
    sock.onData((d) => got.push(Array.from(d)));
    sock.write(Uint8Array.of(0x10, 0x20, 0x30)); // MQTT CONNECT-ish bytes
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([[0x10, 0x20, 0x30]]); // echoed back through the gateway
  });

  it('propagates a remote close to the socket', async () => {
    const gw = new MockGateway();
    const client = new Tier3GatewayClient({ url: 'wss://gw', wsFactory: () => gw });
    await client.connect();
    const sock = client.openTcp('host', 80);
    let closed = false;
    sock.onClose(() => (closed = true));
    gw.remoteClose(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(true);
    expect(sock.closed).toBe(true);
  });

  it('multiplexes independent connections by id', async () => {
    const gw = new MockGateway();
    const client = new Tier3GatewayClient({ url: 'wss://gw', wsFactory: () => gw });
    await client.connect();
    const a = client.openTcp('a', 1);
    const b = client.openTcp('b', 2);
    const aGot: number[][] = [];
    const bGot: number[][] = [];
    a.onData((d) => aGot.push(Array.from(d)));
    b.onData((d) => bGot.push(Array.from(d)));
    a.write(Uint8Array.of(1));
    b.write(Uint8Array.of(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(aGot).toEqual([[1]]); // a only gets a's echo
    expect(bGot).toEqual([[2]]);
    expect(gw.opened.map((o) => o.id)).toEqual([1, 2]);
  });
});
