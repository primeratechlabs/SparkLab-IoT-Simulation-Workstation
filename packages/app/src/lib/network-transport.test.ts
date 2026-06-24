import { describe, it, expect } from 'vitest';
import {
  Tier1Network,
  Tier2Network,
  FakeMqttBroker,
  WL_IDLE_STATUS,
  WL_CONNECTED,
  WL_DISCONNECTED,
} from '@sparklab/network-shim';
import { createNetworkTransport, wifiPhase } from './network-transport';

describe('network-transport — tier → transport selection (client-side, I8)', () => {
  it("'off' yields no transports (a plain non-WiFi sketch)", () => {
    expect(createNetworkTransport('off')).toEqual({ net: null, mqtt: null, blynk: null });
  });

  it("'fake' yields a Tier-1 (offline) network + a loopback MQTT broker", () => {
    const sel = createNetworkTransport('fake');
    expect(sel.net).toBeInstanceOf(Tier1Network);
    expect(sel.mqtt).toBeInstanceOf(FakeMqttBroker);
    // deterministic: WiFi connects after 3 polls (no egress, no real broker)
    expect(sel.net!.wifi.status()).toBe(WL_IDLE_STATUS);
    sel.net!.wifi.begin('x');
    sel.net!.wifi.poll();
    sel.net!.wifi.poll();
    sel.net!.wifi.poll();
    expect(sel.net!.wifi.status()).toBe(WL_CONNECTED);
  });

  it("'real' uses an injected fetch for HTTP and only adds MQTT when a broker URL is given", () => {
    const fetchFn = async () => ({ status: 200, text: async () => 'ok' });
    const wsFactory = () =>
      ({ send() {}, close() {}, addEventListener() {}, removeEventListener() {} }) as never;
    expect(createNetworkTransport('real', { fetchFn }).net).toBeInstanceOf(Tier2Network);
    expect(createNetworkTransport('real', { fetchFn }).mqtt).toBeNull(); // no url → no MQTT
    expect(
      createNetworkTransport('real', { fetchFn, mqttWsUrl: 'wss://broker.example/mqtt', wsFactory })
        .mqtt,
    ).not.toBeNull();
  });

  it("'real' MQTT degrades to null (no throw) when no WebSocket + no wsFactory is available", () => {
    const fetchFn = async () => ({ status: 200, text: async () => 'ok' });
    // happy-dom has no global WebSocket; without an injected factory the run must still proceed.
    expect(
      createNetworkTransport('real', { fetchFn, mqttWsUrl: 'wss://broker.example/mqtt' }).mqtt,
    ).toBeNull();
  });

  it('wifiPhase maps WL_* codes to UI phases', () => {
    expect(wifiPhase(undefined)).toBe('off');
    expect(wifiPhase(WL_IDLE_STATUS)).toBe('off');
    expect(wifiPhase(WL_DISCONNECTED)).toBe('connecting');
    expect(wifiPhase(WL_CONNECTED)).toBe('connected');
  });
});
