/**
 * Stage 6 — network endpoint configuration. The endpoints a sketch reaches (MQTT broker over
 * WebSocket, an optional self-hosted gateway, an optional HTTP proxy) are CONFIG, not code, so
 * they can be swapped in `.env` without touching the firmware or the app.
 *
 * Default: a FREE public MQTT broker that exposes a WebSocket listener (EMQX public broker), so
 * a sketch reaches a real broker over the Internet with NO gateway and NO server of your own.
 * NOTE: public brokers are SHARED and unauthenticated — fine for learning/testing, but use a
 * unique topic prefix and never send private data. For private use, point MQTT_WS_URL at HiveMQ
 * Cloud (free tier, account) or your own broker.
 *
 * Reads from a plain env map so it works in both Vite (`import.meta.env.VITE_*`) and Node
 * (`process.env.*`) — the caller passes whichever it has.
 */

/**
 * The simulator's virtual WiFi access point (Wokwi-GUEST analog). A sketch connects with the REAL
 * arduino-esp32 WiFi API — `WiFi.begin(VIRTUAL_WIFI.ssid, VIRTUAL_WIFI.password)` — and the simulated
 * station (WiFiSim) brings the link up. It is open (no password) and accepts ANY credentials, so a
 * paste-from-the-internet sketch with its own SSID also connects (the sim never rejects a join). The
 * UI advertises this SSID so the learner knows what to use.
 */
export const VIRTUAL_WIFI = { ssid: 'Sparklab-GUEST', password: '' } as const;

/** Free public MQTT-over-WebSocket brokers (no signup), for `.env` reference. Only `wss://` is listed:
 *  the app runs cross-origin-isolated over HTTPS, where a `ws://` broker is blocked by both CSP
 *  (connect-src has no `ws:`) and mixed-content — an insecure broker simply cannot work here. */
export const PUBLIC_MQTT_WS_BROKERS = {
  emqx: 'wss://broker.emqx.io:8084/mqtt',
  mosquitto: 'wss://test.mosquitto.org:8081/mqtt',
} as const;

export const DEFAULT_MQTT_WS_URL = PUBLIC_MQTT_WS_BROKERS.emqx;

export interface NetworkConfig {
  /** MQTT broker WebSocket URL (Tier 2, direct — no gateway). */
  mqttWsUrl: string;
  /** Optional self-hosted gateway WSS URL (Tier 3 — raw TCP/TLS relay). */
  gatewayWsUrl?: string;
  /** Optional HTTP proxy base for non-CORS endpoints (Tier 3). */
  httpProxyUrl?: string;
}

/** Resolve the network config from an env map (VITE_* or bare), falling back to free defaults. */
export function resolveNetworkConfig(env: Record<string, string | undefined> = {}): NetworkConfig {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = env[k];
      if (v && v.trim()) return v.trim();
    }
    return undefined;
  };
  const mqttWsUrl = pick('MQTT_WS_URL', 'VITE_MQTT_WS_URL') ?? DEFAULT_MQTT_WS_URL;
  // A `ws://` broker can't work in the deployed app (CSP connect-src is `https: wss:`, and HTTPS pages
  // block insecure ws:) — make that diagnosable instead of a silent connect failure.
  if (mqttWsUrl.startsWith('ws://') && typeof console !== 'undefined')
    console.warn(
      `[sparklab] MQTT_WS_URL is insecure ws:// (${mqttWsUrl}); it will be blocked over HTTPS — use a wss:// broker.`,
    );
  return {
    mqttWsUrl,
    gatewayWsUrl: pick('GATEWAY_WS_URL', 'VITE_GATEWAY_WS_URL'),
    httpProxyUrl: pick('HTTP_PROXY_URL', 'VITE_HTTP_PROXY_URL'),
  };
}
