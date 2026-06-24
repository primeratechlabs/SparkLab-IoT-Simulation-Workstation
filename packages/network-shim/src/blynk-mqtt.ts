/**
 * Blynk device presence over MQTT-over-WebSocket — the piece that makes a *simulated* device show
 * "online" on the REAL Blynk dashboard, fully client-side (no gateway, invariant I8 backend=0).
 *
 * Why this exists: Blynk's "device online" indicator (and the "Connected to blynk.cloud" handshake
 * the firmware prints) comes from a PERSISTENT device session. The stock Blynk library holds that
 * session over raw TCP/TLS — which a browser cannot open. But Blynk *also* exposes the device session
 * over MQTT-over-WebSocket:
 *     wss://blynk.cloud:443/mqtt   username "device"   password = the device auth token
 * and a browser CAN open a WebSocket. Holding that MQTT connection alive is what registers the device
 * as online. This class owns ONLY that online *presence* (connect + keepalive + status); the actual
 * data (Blynk.virtualWrite / BLYNK_WRITE) keeps flowing over Blynk's pin-based HTTP Device API (see
 * BlynkSim in the firmware shim) because the MQTT API addresses datastreams by NAME, not pin V<n>.
 * Hybrid by design: MQTT for "online", HTTP for pin data.
 */
import { Tier2Mqtt, type WebSocketFactory } from './tier2-mqtt.js';

/** 0 idle (no begin yet) · 1 connecting · 2 connected (device online) · 3 failed/dropped. */
export type BlynkPresenceStatus = 0 | 1 | 2 | 3;

/** A persistent Blynk device session. `begin()` opens it; the firmware shim polls `status()`. */
export interface BlynkPresence {
  begin(token: string): void;
  status(): BlynkPresenceStatus;
  /** Handshake round-trip in ms (for the firmware's "Ready (ping: Xms)" log); 0 if unknown. */
  pingMs(): number;
  disconnect(): void;
}

/** Blynk's MQTT-over-WebSocket device endpoint. Regional hosts (sgp1/fra1/…) also work; this is the
 *  GeoDNS entry that redirects to the nearest one. */
export const BLYNK_MQTT_URL = 'wss://blynk.cloud:443/mqtt';

/**
 * Tier-1 / test presence: "connects" instantly with no network, so the deterministic Blynk gate runs
 * offline (backend=0). Records the token for assertions.
 */
export class FakeBlynkPresence implements BlynkPresence {
  private st: BlynkPresenceStatus = 0;
  token = '';
  begin(token: string): void {
    this.token = token;
    this.st = 2;
  }
  status(): BlynkPresenceStatus {
    return this.st;
  }
  pingMs(): number {
    return 1;
  }
  disconnect(): void {
    this.st = 0;
  }
}

/**
 * Tier-2 presence: a REAL Blynk device session over MQTT-over-WebSocket to blynk.cloud. The live
 * connection is what makes the device appear online on the user's dashboard. Connect is async; the
 * firmware shim spins on `status()` while the worker tick loop yields (same pattern as HTTP_READY).
 */
export class Tier2BlynkPresence implements BlynkPresence {
  private st: BlynkPresenceStatus = 0;
  private mqtt: Tier2Mqtt | null = null;
  private ping = 0;
  private readonly url: string;
  private readonly wsFactory?: WebSocketFactory;

  constructor(opts: { url?: string; wsFactory?: WebSocketFactory } = {}) {
    this.url = opts.url ?? BLYNK_MQTT_URL;
    this.wsFactory = opts.wsFactory;
  }

  begin(token: string): void {
    if (this.st === 1 || this.st === 2) return; // already connecting/online (idempotent re-begin)
    this.st = 1;
    const started = Date.now();
    // Blynk auth: empty client id, username "device", password = the device token. Clean session.
    const mqtt = new Tier2Mqtt({
      url: this.url,
      clientId: '',
      username: 'device',
      password: token,
      wsFactory: this.wsFactory,
    });
    this.mqtt = mqtt;
    mqtt.connect().then(
      () => {
        this.ping = Math.max(1, Math.round(Date.now() - started));
        this.st = 2;
      },
      () => {
        this.st = 3;
      },
    );
  }

  status(): BlynkPresenceStatus {
    if (this.st === 2 && this.mqtt && !this.mqtt.connected()) this.st = 3; // session dropped
    return this.st;
  }

  pingMs(): number {
    return this.ping;
  }

  disconnect(): void {
    this.mqtt?.disconnect();
    this.mqtt = null;
    this.st = 0;
  }
}
