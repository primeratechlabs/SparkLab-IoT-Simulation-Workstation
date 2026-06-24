/**
 * Network tier selection for the workspace runner. Maps a UI tier choice to the @sparklab/network-shim
 * transport(s) the sim worker binds to the firmware's C3Net (WiFi/HTTP/MQTT MMIO). All client-side
 * (invariant I8 — no server compile/run):
 *   'fake' — Tier 1, fully offline + deterministic: simulated WiFi, an echo HTTP server, loopback MQTT.
 *   'real' — Tier 2, the real Internet: browser fetch (CORS-aware) + MQTT over a real WebSocket broker.
 *   'off'  — no network (a plain GPIO/sensor sketch; the runner maps no C3Net).
 * Pure + dependency-injectable (fetch/WebSocket/server stubs) so the mapping is unit-tested without egress.
 */
import {
  Tier1Network,
  Tier2Network,
  Tier2Mqtt,
  FakeHttpServer,
  FakeMqttBroker,
  FakeBlynkServer,
  FakeBlynkPresence,
  Tier2BlynkPresence,
  WL_CONNECTED,
  WL_IDLE_STATUS,
  type NetworkTransport,
  type MqttTransport,
  type BlynkPresence,
  type FetchFn,
  type WebSocketFactory,
} from '@sparklab/network-shim';

export type NetworkTier = 'off' | 'fake' | 'real';

/** The WiFi connection phase the UI shows (mirrors a sketch's WiFi.status() progression). */
export type WifiPhase = 'off' | 'connecting' | 'connected';

export interface NetworkSelection {
  net: NetworkTransport | null;
  mqtt: MqttTransport | null;
  /** Blynk device presence (online status over MQTT-over-WebSocket); null when no network. */
  blynk: BlynkPresence | null;
}

export interface NetworkTransportOpts {
  /** real-tier HTTP (defaults to the global fetch — present in workers). */
  fetchFn?: FetchFn;
  /** real-tier MQTT broker WebSocket URL (omit → no MQTT on the real tier). */
  mqttWsUrl?: string;
  /** real-tier WebSocket factory (defaults to the global WebSocket). */
  wsFactory?: WebSocketFactory;
  /** fake-tier HTTP server (defaults to a bare echo server: any POST → 200 + the same body). */
  fakeServer?: FakeHttpServer;
  /** fake-tier broker (defaults to a fresh loopback FakeMqttBroker). */
  fakeBroker?: FakeMqttBroker;
}

/** Build the transport(s) the runner's C3Net delegates to for a chosen tier (see file header). */
export function createNetworkTransport(
  tier: NetworkTier,
  opts: NetworkTransportOpts = {},
): NetworkSelection {
  if (tier === 'off') return { net: null, mqtt: null, blynk: null };
  if (tier === 'fake') {
    // The fake HTTP server gets a blynk.cloud route (an offline Blynk loopback) so a firmware Blynk
    // sketch runs deterministically with no egress; other hosts fall back to the default echo. The
    // fake presence reports "online" instantly so the device-online flow is exercised offline.
    const server =
      opts.fakeServer ?? new FakeHttpServer().route('blynk.cloud', new FakeBlynkServer().handler());
    return {
      net: new Tier1Network({ connectPolls: 3, server }),
      mqtt: opts.fakeBroker ?? new FakeMqttBroker(),
      blynk: new FakeBlynkPresence(),
    };
  }
  // real (Tier 2): browser fetch + MQTT over WebSocket. No fetch / no WebSocket (rare) → that transport
  // degrades to null rather than throwing, so the run still proceeds (the missing capability is reported).
  // Blynk presence connects to blynk.cloud lazily, on the firmware's Blynk.begin (the token arrives then).
  const fetchFn = opts.fetchFn ?? (globalThis as { fetch?: FetchFn }).fetch;
  const hasWs =
    opts.wsFactory !== undefined ||
    typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined';
  return {
    net: fetchFn ? new Tier2Network({ fetchFn }) : null,
    mqtt:
      opts.mqttWsUrl && hasWs
        ? new Tier2Mqtt({ url: opts.mqttWsUrl, wsFactory: opts.wsFactory })
        : null,
    blynk: hasWs ? new Tier2BlynkPresence({ wsFactory: opts.wsFactory }) : null,
  };
}

/** Map a raw WiFiSim status code (WL_*) to the UI-facing phase. */
export function wifiPhase(status: number | undefined): WifiPhase {
  if (status === undefined || status === WL_IDLE_STATUS) return 'off';
  if (status === WL_CONNECTED) return 'connected';
  return 'connecting'; // WL_DISCONNECTED while the connect polls advance
}
