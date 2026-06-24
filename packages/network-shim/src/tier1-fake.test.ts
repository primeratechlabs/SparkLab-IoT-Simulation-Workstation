import { describe, it, expect } from 'vitest';
import {
  WiFiSim,
  FakeHttpServer,
  Tier1Network,
  parseHalRequest,
  WL_IDLE_STATUS,
  WL_CONNECTED,
  type HttpRequest,
} from './tier1-fake.js';

describe('network-shim tier 1 — WiFiSim', () => {
  it('reaches WL_CONNECTED deterministically after begin + polls', () => {
    const wifi = new WiFiSim(3);
    expect(wifi.status()).toBe(WL_IDLE_STATUS);
    wifi.begin('sparklab');
    wifi.poll();
    wifi.poll();
    expect(wifi.status()).not.toBe(WL_CONNECTED); // still connecting
    wifi.poll();
    expect(wifi.status()).toBe(WL_CONNECTED);
    expect(wifi.connectedSsid()).toBe('sparklab');
    expect(wifi.localIp).toBe('192.168.4.2');
  });

  it('disconnect drops the link and re-connects on the same schedule', () => {
    const wifi = new WiFiSim(1);
    wifi.begin('x');
    wifi.poll();
    expect(wifi.status()).toBe(WL_CONNECTED);
    wifi.disconnect();
    expect(wifi.status()).not.toBe(WL_CONNECTED);
    wifi.poll();
    expect(wifi.status()).toBe(WL_CONNECTED);
  });
});

describe('network-shim tier 1 — FakeHttpServer', () => {
  it('routes by host/path and records requests; default route echoes the body', () => {
    const server = new FakeHttpServer();
    server.route(
      'api.sparklab.dev',
      (req) => ({ status: 200, body: `ACK ${req.body}` }),
      '/ingest',
    );

    const r1 = server.handle({
      method: 'POST',
      host: 'api.sparklab.dev',
      port: 80,
      path: '/ingest',
      body: '512',
    });
    expect(r1).toEqual({ status: 200, body: 'ACK 512' });

    const r2 = server.handle({ method: 'GET', host: 'other.dev', port: 80, path: '/', body: 'hi' });
    expect(r2).toEqual({ status: 200, body: 'hi' }); // default echo

    expect(server.requests).toHaveLength(2);
    expect(server.lastRequest()?.host).toBe('other.dev');
  });
});

describe('network-shim tier 1 — Tier1Network (sensor value round-trip)', () => {
  it('blocks fetch until WiFi is up, then sends a sensor value and receives a command', () => {
    // Server: store the reported sensor value, reply with a relay command (on if value > 2000).
    let stored = -1;
    const server = new FakeHttpServer().route('iot.local', (req) => {
      stored = Number(req.body);
      return { status: 200, body: stored > 2000 ? 'RELAY=1' : 'RELAY=0' };
    });
    const net = new Tier1Network({ connectPolls: 2, server });

    const req: HttpRequest = {
      method: 'POST',
      host: 'iot.local',
      port: 80,
      path: '/telemetry',
      body: '2750',
    };
    expect(net.fetch(req).status).toBe(0); // not connected yet

    net.wifi.begin('sparklab');
    net.wifi.poll();
    net.wifi.poll();
    const res = net.fetch(req);

    expect(res).toEqual({ status: 200, body: 'RELAY=1' }); // received a value back over "internet"
    expect(stored).toBe(2750); // the sensor value was sent and observed server-side
  });
});

describe('network-shim tier 1 — parseHalRequest', () => {
  it('parses the compact MMIO request line + body', () => {
    const req = parseHalRequest('POST iot.local:80 /telemetry\nVAL=1234');
    expect(req).toEqual({
      method: 'POST',
      host: 'iot.local',
      port: 80,
      path: '/telemetry',
      body: 'VAL=1234',
    });
  });
  it('defaults method/port/path and tolerates a missing body', () => {
    const req = parseHalRequest('GET example.com /status');
    expect(req).toEqual({
      method: 'GET',
      host: 'example.com',
      port: 80,
      path: '/status',
      body: '',
    });
  });
});
