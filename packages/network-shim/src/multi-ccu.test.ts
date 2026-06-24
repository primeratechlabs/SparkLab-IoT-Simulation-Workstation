/**
 * Stage 7 — multi-CCU (many concurrent connected users/devices). Classroom scale: many devices
 * share one broker; each must see ONLY its own topics (no cross-talk), and a broadcast must reach
 * all. The deterministic tests run in CI; a small real-broker concurrency check runs when EMQX is
 * reachable.
 */
import { describe, it, expect } from 'vitest';
import { FakeMqttBroker, Tier2Mqtt } from './index.js';
import { DEFAULT_MQTT_WS_URL } from './config.js';

describe('multi-CCU — many devices on one fake broker (isolation at scale)', () => {
  it('routes per-device command topics with zero cross-talk', () => {
    const broker = new FakeMqttBroker();
    const N = 64;
    const received: string[][] = Array.from({ length: N }, () => []);
    for (let i = 0; i < N; i++)
      broker.subscribe(`dev/${i}/cmd`, (m) => received[i]!.push(m.payload));

    // every device publishes telemetry, and the cloud sends each a UNIQUE command
    for (let i = 0; i < N; i++) broker.publish(`dev/${i}/telemetry`, String(i * 10));
    for (let i = 0; i < N; i++) broker.inject(`dev/${i}/cmd`, `cmd-${i}`);

    for (let i = 0; i < N; i++) {
      expect(received[i]).toEqual([`cmd-${i}`]); // each device got exactly its own command
      expect(broker.last(`dev/${i}/telemetry`)?.payload).toBe(String(i * 10));
    }
  });

  it('a broadcast reaches all subscribers; a device topic reaches only that device', () => {
    const broker = new FakeMqttBroker();
    const N = 50;
    let broadcastHits = 0;
    let deviceHits = 0;
    for (let i = 0; i < N; i++) broker.subscribe('fleet/announce', () => broadcastHits++);
    broker.subscribe('dev/7/cmd', () => deviceHits++);

    broker.publish('fleet/announce', 'reboot');
    broker.publish('dev/7/cmd', 'on');

    expect(broadcastHits).toBe(N); // all devices heard the broadcast
    expect(deviceHits).toBe(1); // only device 7 heard its command
  });

  it('interleaved publishes from many devices stay correctly attributed', () => {
    const broker = new FakeMqttBroker();
    const N = 40;
    const seen: Record<string, string[]> = {};
    for (let i = 0; i < N; i++) {
      seen[`dev/${i}`] = [];
      broker.subscribe(`dev/${i}/echo`, (m) => seen[`dev/${i}`]!.push(m.payload));
    }
    // round-robin interleave: each device publishes 3 messages, intermixed
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < N; i++) broker.publish(`dev/${i}/echo`, `${i}:${round}`);
    }
    for (let i = 0; i < N; i++) {
      expect(seen[`dev/${i}`]).toEqual([`${i}:0`, `${i}:1`, `${i}:2`]); // exactly its own, in order
    }
  });
});

describe('multi-CCU — concurrent real broker clients (EMQX over WSS, best-effort)', () => {
  it('N independent clients each round-trip only their own topic — skipped if unreachable', async (ctx) => {
    if (typeof WebSocket === 'undefined') return ctx.skip();
    const N = 3;
    const prefix = `sparklab/ccu/${Math.random().toString(16).slice(2)}`;
    const clients: Tier2Mqtt[] = [];
    try {
      for (let i = 0; i < N; i++) {
        const c = new Tier2Mqtt({ url: DEFAULT_MQTT_WS_URL });
        await c.connect(8000);
        clients.push(c);
      }
    } catch {
      for (const c of clients) c.disconnect();
      return ctx.skip();
    }
    const got: string[][] = Array.from({ length: N }, () => []);
    clients.forEach((c, i) => c.subscribe(`${prefix}/${i}`, (m) => got[i]!.push(m.payload)));
    await new Promise((r) => setTimeout(r, 800)); // let all SUBSCRIBEs register
    clients.forEach((c, i) => c.publish(`${prefix}/${i}`, `hi-${i}`));
    for (let k = 0; k < 40 && got.some((g) => g.length === 0); k++)
      await new Promise((r) => setTimeout(r, 100));
    clients.forEach((c) => c.disconnect());

    for (let i = 0; i < N; i++) expect(got[i]).toContain(`hi-${i}`); // each got its own
    for (let i = 0; i < N; i++) expect(got[i]!.some((p) => p !== `hi-${i}`)).toBe(false); // and nothing else
  }, 30000);
});
