/**
 * Stage 6 — C3Net MMIO bridge (always-run, no toolchain). Drives the network registers the way
 * the firmware HAL does and checks the WiFi-connect + HTTP value round-trip against the Tier-1
 * fake network. The integration tests (esp32*-network-sim) prove the same path from real
 * client-built firmware; this locks the bridge logic into CI.
 */
import { describe, it, expect } from 'vitest';
import { C3Net, C3_NET_BASE } from './net-sim.js';
import {
  Tier1Network,
  FakeHttpServer,
  FakeMqttBroker,
  WiFiSim,
  WL_CONNECTED,
  type NetworkTransport,
  type HttpResponse,
} from '@sparklab/network-shim';

const WIFI_SSID = 0x00;
const WIFI_BEGIN = 0x04;
const WIFI_STATUS = 0x08;
const REQ_CHAR = 0x10;
const HTTP_SEND = 0x14;
const HTTP_STATUS = 0x18;
const RX_AVAIL = 0x1c;
const RX_CHAR = 0x20;
const HTTP_READY = 0x24;
const MQTT_TOPIC = 0x30;
const MQTT_PAY = 0x34;
const MQTT_PUB = 0x38;
const MQTT_SUB = 0x3c;
const MQTT_AVAIL = 0x40;
const MQTT_RX = 0x44;
const MQTT_NEXT = 0x48;

/** Stream a string into a byte register the way the HAL does (one char per write). */
function stream(net: C3Net, off: number, s: string): void {
  for (const ch of s) net.write8(C3_NET_BASE + off, ch.charCodeAt(0));
}

describe('C3Net MMIO bridge', () => {
  it('drives WiFi connect + an HTTP value round-trip through the registers', () => {
    let serverSaw = -1;
    const server = new FakeHttpServer().route('iot.local', (req) => {
      serverSaw = Number(req.body.replace('VAL=', ''));
      return { status: 200, body: serverSaw > 2000 ? '1' : '0' };
    });
    const net = new C3Net(new Tier1Network({ connectPolls: 3, server }));

    // WiFi.begin("wifi")
    stream(net, WIFI_SSID, 'wifi');
    net.write32(C3_NET_BASE + WIFI_BEGIN, 1);

    // spin on status() — each read advances the connect machine; connected after 3 polls
    let st = 0;
    for (let i = 0; i < 4; i++) st = net.read32(C3_NET_BASE + WIFI_STATUS);
    expect(st).toBe(WL_CONNECTED);

    // POST iot.local:80 /telemetry  body VAL=2750
    stream(net, REQ_CHAR, 'POST iot.local:80 /telemetry\nVAL=2750');
    net.write32(C3_NET_BASE + HTTP_SEND, 1);

    expect(net.read32(C3_NET_BASE + HTTP_READY)).toBe(1); // Tier 1 latches synchronously
    expect(net.read32(C3_NET_BASE + HTTP_STATUS)).toBe(200);
    expect(serverSaw).toBe(2750); // the sensor value reached the server
    expect(server.lastRequest()?.path).toBe('/telemetry');

    // read the reply body back, one byte at a time
    expect(net.read32(C3_NET_BASE + RX_AVAIL)).toBe(1);
    expect(net.read32(C3_NET_BASE + RX_CHAR)).toBe('1'.charCodeAt(0));
    expect(net.read32(C3_NET_BASE + RX_AVAIL)).toBe(0); // drained
    expect(net.read32(C3_NET_BASE + RX_CHAR)).toBe(0);
  });

  it('a request before WiFi is connected returns status 0 (no fetch)', () => {
    const server = new FakeHttpServer();
    const net = new C3Net(new Tier1Network({ connectPolls: 5, server }));
    stream(net, WIFI_SSID, 'x');
    net.write32(C3_NET_BASE + WIFI_BEGIN, 1); // begin but do NOT poll to connected

    stream(net, REQ_CHAR, 'GET iot.local:80 /\nping');
    net.write32(C3_NET_BASE + HTTP_SEND, 1);

    expect(net.read32(C3_NET_BASE + HTTP_STATUS)).toBe(0);
    expect(server.requests).toHaveLength(0); // nothing left the device
  });
});

describe('C3Net MMIO bridge — async transport (Tier 2)', () => {
  it('keeps HTTP_READY at 0 until the async fetch resolves, then latches the response', async () => {
    let resolveFetch!: (r: HttpResponse) => void;
    const transport: NetworkTransport = {
      wifi: new WiFiSim(1),
      fetch: () =>
        new Promise<HttpResponse>((res) => {
          resolveFetch = res;
        }),
    };
    const net = new C3Net(transport);

    stream(net, WIFI_SSID, 'wifi');
    net.write32(C3_NET_BASE + WIFI_BEGIN, 1);
    expect(net.read32(C3_NET_BASE + WIFI_STATUS)).toBe(WL_CONNECTED);

    stream(net, REQ_CHAR, 'GET api.example.com:80 /v\nVAL=7');
    net.write32(C3_NET_BASE + HTTP_SEND, 1);
    expect(net.read32(C3_NET_BASE + HTTP_READY)).toBe(0); // request in flight (the firmware spins)

    resolveFetch({ status: 200, body: 'OK' });
    await Promise.resolve(); // flush the .then microtask
    expect(net.read32(C3_NET_BASE + HTTP_READY)).toBe(1);
    expect(net.read32(C3_NET_BASE + HTTP_STATUS)).toBe(200);
    expect(net.read32(C3_NET_BASE + RX_CHAR)).toBe('O'.charCodeAt(0));
    expect(net.read32(C3_NET_BASE + RX_CHAR)).toBe('K'.charCodeAt(0));
  });
});

describe('C3Net MMIO bridge — MQTT pub/sub (Tier 1 fake broker)', () => {
  it('publishes a sensor value and receives an injected command via the broker', () => {
    const broker = new FakeMqttBroker();
    const net = new C3Net(new Tier1Network({ connectPolls: 1 }), broker);

    // WiFi up
    net.write32(C3_NET_BASE + WIFI_BEGIN, 1);
    expect(net.read32(C3_NET_BASE + WIFI_STATUS)).toBe(WL_CONNECTED);

    // subscribe to the command topic, then publish telemetry
    stream(net, MQTT_TOPIC, 'dev/1/cmd');
    net.write32(C3_NET_BASE + MQTT_SUB, 1);
    stream(net, MQTT_TOPIC, 'dev/1/telemetry');
    stream(net, MQTT_PAY, '2750');
    net.write32(C3_NET_BASE + MQTT_PUB, 1);
    expect(broker.last('dev/1/telemetry')?.payload).toBe('2750');

    // cloud → device command lands in the rx queue
    expect(net.read32(C3_NET_BASE + MQTT_AVAIL)).toBe(0);
    broker.inject('dev/1/cmd', '1');
    expect(net.read32(C3_NET_BASE + MQTT_AVAIL)).toBe(1);
    expect(net.read32(C3_NET_BASE + MQTT_RX)).toBe('1'.charCodeAt(0));
    expect(net.read32(C3_NET_BASE + MQTT_RX)).toBe(0); // front message drained
    net.write32(C3_NET_BASE + MQTT_NEXT, 1);
    expect(net.read32(C3_NET_BASE + MQTT_AVAIL)).toBe(0);
  });

  it('does not publish while WiFi is disconnected', () => {
    const broker = new FakeMqttBroker();
    const net = new C3Net(new Tier1Network({ connectPolls: 5 }), broker);
    net.write32(C3_NET_BASE + WIFI_BEGIN, 1); // begun, but never polled to connected
    stream(net, MQTT_TOPIC, 't');
    stream(net, MQTT_PAY, '9');
    net.write32(C3_NET_BASE + MQTT_PUB, 1);
    expect(broker.published).toHaveLength(0);
  });
});
