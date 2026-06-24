import { describe, it, expect } from 'vitest';
import { Tier2Mqtt, type WebSocketLike } from './tier2-mqtt.js';
import { DEFAULT_MQTT_WS_URL } from './config.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Decode an MQTT packet body (handles multi-byte remaining length). */
function body(data: Uint8Array): Uint8Array {
  let i = 1;
  let mult = 1;
  let len = 0;
  let b: number;
  do {
    b = data[i++]!;
    len += (b & 0x7f) * mult;
    mult *= 128;
  } while (b & 0x80);
  return data.slice(i, i + len);
}
function buildPublish(topic: string, payload: string): Uint8Array {
  const tb = Array.from(enc.encode(topic));
  const pb = Array.from(enc.encode(payload));
  const b = [(tb.length >> 8) & 0xff, tb.length & 0xff, ...tb, ...pb];
  return Uint8Array.from([0x30, ...remLen(b.length), ...b]);
}
function remLen(n: number): number[] {
  const out: number[] = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return out;
}

/** Deterministic in-memory MQTT broker that loops published messages back to subscribers. */
class LoopbackBroker implements WebSocketLike {
  readyState = 1;
  binaryType = 'arraybuffer';
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  private readonly topics = new Set<string>();

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  send(data: Uint8Array): void {
    const type = data[0]! >> 4;
    if (type === 1) {
      this.deliver(Uint8Array.from([0x20, 0x02, 0x00, 0x00])); // CONNACK ok
    } else if (type === 8) {
      const bd = body(data);
      const tl = (bd[2]! << 8) | bd[3]!;
      this.topics.add(dec.decode(bd.slice(4, 4 + tl)));
      this.deliver(Uint8Array.from([0x90, 0x03, bd[0]!, bd[1]!, 0x00])); // SUBACK
    } else if (type === 3) {
      const bd = body(data);
      const tl = (bd[0]! << 8) | bd[1]!;
      const topic = dec.decode(bd.slice(2, 2 + tl));
      const payload = dec.decode(bd.slice(2 + tl));
      if (this.topics.has(topic)) this.deliver(buildPublish(topic, payload));
    }
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  private deliver(bytes: Uint8Array): void {
    queueMicrotask(() => this.onmessage?.({ data: bytes.buffer }));
  }
}

describe('tier2-mqtt — Tier2Mqtt over a loopback broker (deterministic)', () => {
  it('connects, subscribes, publishes, and receives its own message', async () => {
    const mqtt = new Tier2Mqtt({ url: 'wss://broker', wsFactory: () => new LoopbackBroker() });
    await mqtt.connect();
    expect(mqtt.connected()).toBe(true);

    const got: { topic: string; payload: string }[] = [];
    mqtt.subscribe('dev/1/data', (m) => got.push(m));
    await Promise.resolve();
    mqtt.publish('dev/1/data', '2750');
    await new Promise((r) => setTimeout(r, 0));

    expect(got).toEqual([{ topic: 'dev/1/data', payload: '2750' }]);
  });

  it('does not deliver to a topic that was not subscribed', async () => {
    const mqtt = new Tier2Mqtt({ url: 'wss://broker', wsFactory: () => new LoopbackBroker() });
    await mqtt.connect();
    const got: unknown[] = [];
    mqtt.subscribe('a', () => got.push(1));
    await Promise.resolve();
    mqtt.publish('b', 'x'); // different topic
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(0);
  });

  it('publish before connect is a no-op (no throw)', () => {
    const mqtt = new Tier2Mqtt({ url: 'wss://broker', wsFactory: () => new LoopbackBroker() });
    expect(mqtt.connected()).toBe(false);
    expect(() => mqtt.publish('t', 'x')).not.toThrow();
  });
});

describe('tier2-mqtt — REAL public broker (EMQX over WSS)', () => {
  it('connects to the free public broker and round-trips a message — skipped if offline', async (ctx) => {
    if (typeof WebSocket === 'undefined') return ctx.skip();
    const topic = `sparklab/itest/${Math.random().toString(16).slice(2)}`;
    let mqtt: Tier2Mqtt;
    try {
      mqtt = new Tier2Mqtt({ url: DEFAULT_MQTT_WS_URL });
      await mqtt.connect(8000);
    } catch {
      return ctx.skip(); // broker unreachable / offline
    }
    const got: string[] = [];
    mqtt.subscribe(topic, (m) => got.push(m.payload));
    await new Promise((r) => setTimeout(r, 600)); // let the SUBSCRIBE register
    mqtt.publish(topic, 'VAL=2750');
    for (let i = 0; i < 40 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    mqtt.disconnect();
    expect(got).toContain('VAL=2750'); // our value went to the REAL broker and came back
  }, 30000);
});
