import { describe, it, expect } from 'vitest';
import { FakeBlynkPresence, Tier2BlynkPresence } from './blynk-mqtt.js';
import { type WebSocketLike } from './tier2-mqtt.js';

const dec = new TextDecoder();

/** Read the MQTT remaining-length-framed body of a packet. */
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
/** Pop a 2-byte-length-prefixed UTF-8 string at offset; returns [string, nextOffset]. */
function mqttStr(b: Uint8Array, off: number): [string, number] {
  const len = (b[off]! << 8) | b[off + 1]!;
  return [dec.decode(b.slice(off + 2, off + 2 + len)), off + 2 + len];
}

/** A fake WS that records the CONNECT credentials, then ACKs — so we can assert the Blynk auth. */
class CapturingBroker implements WebSocketLike {
  readyState = 1;
  binaryType = 'arraybuffer';
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  connect?: {
    protocol: string;
    flags: number;
    clientId: string;
    username?: string;
    password?: string;
  };

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  send(data: Uint8Array): void {
    if (data[0]! >> 4 === 1) {
      const b = body(data);
      const [protocol, o1] = mqttStr(b, 0);
      const flags = b[o1 + 1]!; // o1=protocol level byte, o1+1=connect flags
      let off = o1 + 4; // skip level(1) + flags(1) + keepalive(2)
      const [clientId, o2] = mqttStr(b, off);
      off = o2;
      let username: string | undefined;
      let password: string | undefined;
      if (flags & 0x80) [username, off] = mqttStr(b, off);
      if (flags & 0x40) [password, off] = mqttStr(b, off);
      this.connect = { protocol, flags, clientId, username, password };
      queueMicrotask(() =>
        this.onmessage?.({ data: Uint8Array.from([0x20, 0x02, 0x00, 0x00]).buffer }),
      ); // CONNACK ok
    }
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('blynk-mqtt — FakeBlynkPresence (offline, deterministic)', () => {
  it('connects instantly and records the token', () => {
    const p = new FakeBlynkPresence();
    expect(p.status()).toBe(0); // idle before begin
    p.begin('TOK123');
    expect(p.status()).toBe(2); // online
    expect(p.token).toBe('TOK123');
    expect(p.pingMs()).toBeGreaterThan(0);
    p.disconnect();
    expect(p.status()).toBe(0);
  });
});

describe('blynk-mqtt — Tier2BlynkPresence (real Blynk MQTT auth shape)', () => {
  it('opens a device session authed as "device" + the token, and reports online', async () => {
    let captured: CapturingBroker | null = null;
    const p = new Tier2BlynkPresence({
      url: 'wss://broker',
      wsFactory: () => (captured = new CapturingBroker()),
    });
    expect(p.status()).toBe(0);
    p.begin('my-device-token');
    expect(p.status()).toBe(1); // connecting

    // let the queued onopen → CONNECT → CONNACK microtasks run
    for (let i = 0; i < 5 && p.status() !== 2; i++) await new Promise((r) => setTimeout(r, 0));

    expect(p.status()).toBe(2); // online
    expect(captured).not.toBeNull();
    expect(captured!.connect?.protocol).toBe('MQTT');
    expect(captured!.connect?.username).toBe('device'); // Blynk device API username is literally "device"
    expect(captured!.connect?.password).toBe('my-device-token'); // password = the auth token
    expect(captured!.connect?.clientId).toBe(''); // Blynk uses an empty client id
  });

  it('re-begin while online is idempotent (no second connection)', async () => {
    let count = 0;
    const p = new Tier2BlynkPresence({
      url: 'wss://broker',
      wsFactory: () => (count++, new CapturingBroker()),
    });
    p.begin('t');
    for (let i = 0; i < 5 && p.status() !== 2; i++) await new Promise((r) => setTimeout(r, 0));
    p.begin('t'); // already online
    expect(count).toBe(1);
  });
});
