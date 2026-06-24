/**
 * Stage 6 — Tier 3 gateway client. When a sketch must reach a service the browser can't (a
 * TCP-only MQTT broker on :1883, a non-CORS HTTP host, raw TLS), it tunnels through a self-hosted
 * gateway over a single WebSocket, multiplexing virtual L4 connections via GatewayFrames
 * (open/data/close). TLS terminates in the firmware — the gateway only relays opaque bytes.
 *
 * This is the CLIENT half (browser side); the server is @sparklab/gateway. The gateway URL/token
 * are .env config (VITE_GATEWAY_WS_URL). WebSocket is injectable for tests.
 */
import { type WebSocketLike, type WebSocketFactory } from './tier2-mqtt.js';

export type GatewayFrame =
  | { t: 'open'; id: number; proto: 'tcp' | 'udp'; host: string; port: number }
  | { t: 'data'; id: number; b: number[] }
  | { t: 'close'; id: number };

/** A virtual TCP connection multiplexed over the gateway WebSocket. */
export interface GatewaySocket {
  write(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
  readonly closed: boolean;
}

class MuxSocket implements GatewaySocket {
  closed = false;
  private dataCb: (d: Uint8Array) => void = () => {};
  private closeCb: () => void = () => {};
  constructor(
    private readonly id: number,
    private readonly sendFrame: (f: GatewayFrame) => void,
    private readonly onLocalClose: (id: number) => void,
  ) {}
  write(data: Uint8Array): void {
    if (!this.closed) this.sendFrame({ t: 'data', id: this.id, b: Array.from(data) });
  }
  onData(cb: (d: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendFrame({ t: 'close', id: this.id });
    this.onLocalClose(this.id);
  }
  /** @internal — called by the client when a frame arrives for this id. */
  _deliver(d: Uint8Array): void {
    this.dataCb(d);
  }
  /** @internal — remote closed. */
  _remoteClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb();
  }
}

export class Tier3GatewayClient {
  private ws: WebSocketLike | null = null;
  private connected = false;
  private nextId = 1;
  private readonly sockets = new Map<number, MuxSocket>();
  private readonly url: string;
  private readonly token?: string;
  private readonly wsFactory: WebSocketFactory;

  constructor(opts: { url: string; token?: string; wsFactory?: WebSocketFactory }) {
    this.url = opts.url;
    this.token = opts.token;
    const f = opts.wsFactory ?? defaultWsFactory();
    this.wsFactory = f;
  }

  connect(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      const full = this.token
        ? `${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`
        : this.url;
      const ws = this.wsFactory(full, '');
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this.connected = true;
        done();
      };
      ws.onmessage = (ev) => this.onFrame(ev.data);
      ws.onerror = () => done(new Error('gateway ws error'));
      ws.onclose = () => {
        this.connected = false;
        for (const s of this.sockets.values()) s._remoteClose();
        this.sockets.clear();
        done(new Error('gateway ws closed'));
      };
      setTimeout(() => done(new Error('gateway connect timeout')), timeoutMs);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Open a virtual TCP connection through the gateway. */
  openTcp(host: string, port: number): GatewaySocket {
    const id = this.nextId++;
    const sock = new MuxSocket(
      id,
      (f) => this.sendFrame(f),
      (sid) => this.sockets.delete(sid),
    );
    this.sockets.set(id, sock);
    this.sendFrame({ t: 'open', id, proto: 'tcp', host, port });
    return sock;
  }

  disconnect(): void {
    this.ws?.close();
    this.connected = false;
  }

  private sendFrame(f: GatewayFrame): void {
    if (this.ws && this.connected) this.ws.send(textBytes(JSON.stringify(f)));
  }
  private onFrame(data: unknown): void {
    let f: GatewayFrame;
    try {
      f = JSON.parse(typeof data === 'string' ? data : decodeText(data)) as GatewayFrame;
    } catch {
      return;
    }
    const sock = this.sockets.get(f.id);
    if (!sock) return;
    if (f.t === 'data') sock._deliver(Uint8Array.from(f.b));
    else if (f.t === 'close') {
      sock._remoteClose();
      this.sockets.delete(f.id);
    }
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
function textBytes(s: string): Uint8Array {
  return encoder.encode(s);
}
function decodeText(data: unknown): string {
  if (data instanceof Uint8Array) return decoder.decode(data);
  if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data))
    return decoder.decode(new Uint8Array((data as ArrayBufferView).buffer));
  return '';
}
function defaultWsFactory(): WebSocketFactory {
  const WS = (globalThis as { WebSocket?: new (url: string, protocol?: string) => unknown })
    .WebSocket;
  if (!WS) throw new Error('Tier3GatewayClient: no global WebSocket (pass opts.wsFactory)');
  return (url) => new WS(url) as unknown as WebSocketLike;
}
