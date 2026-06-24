/**
 * Stage 6 — Tier 2 MQTT over WebSocket (DIRECT, no gateway). The browser's own WebSocket connects
 * to a public MQTT broker's WS listener and we speak minimal MQTT 3.1.1 (QoS 0): CONNECT, PUBLISH,
 * SUBSCRIBE, and inbound PUBLISH. That reaches a REAL broker over the Internet with no server of
 * your own (backend=0, I8). The broker URL is `.env` config (see config.ts) — swap it in seconds.
 *
 * A real ESP32 sketch uses PubSubClient over raw TCP:1883; here the HAL routes those publish/
 * subscribe calls down to this WS transport instead — identical sketch logic, different carrier
 * (the API→HAL bridge). The WebSocket is injectable so tests run against a deterministic loopback
 * broker without the network.
 */
import { type MqttTransport, type MqttSubscriber } from './mqtt.js';

/** The subset of WebSocket this transport needs (DOM/Node global WebSocket satisfy it). */
export interface WebSocketLike {
  readyState: number;
  binaryType?: string;
  send(data: Uint8Array): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export type WebSocketFactory = (url: string, protocol: string) => WebSocketLike;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** MQTT "remaining length" — 7 bits/byte, MSB = continuation. */
function remainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return out;
}
/** Length-prefixed UTF-8 string (2-byte big-endian length + bytes). */
function mqttString(s: string): number[] {
  const b = Array.from(enc.encode(s));
  return [(b.length >> 8) & 0xff, b.length & 0xff, ...b];
}
function packet(type: number, flags: number, body: number[]): Uint8Array {
  return Uint8Array.from([(type << 4) | flags, ...remainingLength(body.length), ...body]);
}
/** Normalise a WebSocket message payload to bytes (ArrayBuffer / typed array / Node Buffer). */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(
      (data as ArrayBufferView).buffer,
      (data as ArrayBufferView).byteOffset,
      (data as ArrayBufferView).byteLength,
    );
  if (typeof data === 'string') return enc.encode(data);
  return new Uint8Array(0);
}

export class Tier2Mqtt implements MqttTransport {
  private ws: WebSocketLike | null = null;
  private isConnected = false;
  private readonly subs = new Map<string, MqttSubscriber[]>();
  private rx: number[] = [];
  private packetId = 1;
  private onConnack: (() => void) | null = null;
  /** PINGREQ keepalive timer — without it the broker drops the connection after the declared keepalive. */
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly url: string;
  private readonly clientId: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly wsFactory: WebSocketFactory;

  constructor(opts: {
    url: string;
    clientId?: string;
    username?: string;
    password?: string;
    wsFactory?: WebSocketFactory;
  }) {
    this.url = opts.url;
    // Blynk's MQTT device API uses an empty client id; for public brokers a random one avoids collisions.
    this.clientId = opts.clientId ?? `sparklab-${Math.random().toString(16).slice(2, 10)}`;
    this.username = opts.username;
    this.password = opts.password;
    const f = opts.wsFactory ?? defaultWsFactory();
    this.wsFactory = f;
  }

  /** Open the WebSocket and complete the MQTT handshake (resolves on a successful CONNACK). */
  connect(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      const ws = this.wsFactory(this.url, 'mqtt');
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      this.onConnack = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.onopen = () => {
        // CONNECT: protocol "MQTT" v4 (3.1.1). Flags: cleanSession(0x02) + username(0x80)/password(0x40)
        // when present (Blynk auth = username "device", password = the device token). Keepalive 60s.
        let flags = 0x02;
        const tail: number[] = [...mqttString(this.clientId)];
        if (this.username !== undefined) {
          flags |= 0x80;
          tail.push(...mqttString(this.username));
        }
        if (this.password !== undefined) {
          flags |= 0x40;
          tail.push(...mqttString(this.password));
        }
        ws.send(packet(1, 0, [...mqttString('MQTT'), 4, flags, 0x00, 0x3c, ...tail]));
      };
      ws.onmessage = (ev) => this.feed(toBytes(ev.data));
      ws.onerror = () => fail(new Error('mqtt ws error'));
      ws.onclose = () => {
        this.isConnected = false;
        this.stopKeepalive();
        fail(new Error('mqtt ws closed before connack'));
      };
      setTimeout(() => fail(new Error('mqtt connect timeout')), timeoutMs);
    });
  }

  connected(): boolean {
    return this.isConnected;
  }

  publish(topic: string, payload: string): void {
    if (!this.ws || !this.isConnected) return;
    this.ws.send(packet(3, 0, [...mqttString(topic), ...Array.from(enc.encode(payload))]));
  }

  subscribe(topic: string, onMessage: MqttSubscriber): void {
    const arr = this.subs.get(topic) ?? [];
    arr.push(onMessage);
    this.subs.set(topic, arr);
    if (this.ws && this.isConnected) {
      const id = this.packetId++ & 0xffff;
      this.ws.send(packet(8, 0x2, [(id >> 8) & 0xff, id & 0xff, ...mqttString(topic), 0]));
    }
  }

  // Keepalive: the CONNECT declares a 60 s keepalive, so send a PINGREQ (0xc0 0x00) every 30 s to keep the
  // session alive. PINGRESP (type 13) is handled (ignored) in handle(). Cleared on disconnect/close.
  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.isConnected) this.ws.send(Uint8Array.from([0xc0, 0x00]));
    }, 30_000);
    (this.pingTimer as { unref?: () => void }).unref?.(); // don't keep a Node process (or test) alive
  }
  private stopKeepalive(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  disconnect(): void {
    this.stopKeepalive();
    this.ws?.send(Uint8Array.from([0xe0, 0x00])); // DISCONNECT
    this.ws?.close();
    this.isConnected = false;
  }

  // ── incoming packet assembly ───────────────────────────────────────────────
  private feed(bytes: Uint8Array): void {
    for (const b of bytes) this.rx.push(b);
    this.parse();
  }
  private parse(): void {
    while (this.rx.length >= 2) {
      let mult = 1;
      let len = 0;
      let i = 1;
      let encByte: number;
      do {
        if (i >= this.rx.length) return; // length field incomplete
        encByte = this.rx[i++]!;
        len += (encByte & 0x7f) * mult;
        mult *= 128;
      } while ((encByte & 0x80) !== 0);
      if (this.rx.length < i + len) return; // body incomplete
      const type = this.rx[0]! >> 4;
      const flags = this.rx[0]! & 0xf;
      const body = this.rx.slice(i, i + len);
      this.rx = this.rx.slice(i + len);
      this.handle(type, flags, body);
    }
  }
  private handle(type: number, flags: number, body: number[]): void {
    if (type === 2) {
      // CONNACK — body[1] is the return code (0 = accepted)
      if (body[1] === 0) {
        this.isConnected = true;
        this.startKeepalive(); // begin PINGREQ so a long-lived (e.g. Blynk) session isn't dropped
        this.onConnack?.();
      }
    } else if (type === 3) {
      // inbound PUBLISH
      const topicLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
      const topic = dec.decode(Uint8Array.from(body.slice(2, 2 + topicLen)));
      let idx = 2 + topicLen;
      if (((flags >> 1) & 3) > 0) idx += 2; // QoS>0 carries a packet id (we sub QoS0, but be safe)
      const payload = dec.decode(Uint8Array.from(body.slice(idx)));
      for (const h of this.subs.get(topic) ?? []) h({ topic, payload });
    }
    // SUBACK (9) / PINGRESP (13) — no action needed for QoS0
  }
}

/** Use the platform's global WebSocket (browser or Node ≥ 22). */
function defaultWsFactory(): WebSocketFactory {
  const WS = (globalThis as { WebSocket?: new (url: string, protocol?: string) => unknown })
    .WebSocket;
  if (!WS) throw new Error('Tier2Mqtt: no global WebSocket (pass opts.wsFactory)');
  return (url, protocol) => new WS(url, protocol) as unknown as WebSocketLike;
}
