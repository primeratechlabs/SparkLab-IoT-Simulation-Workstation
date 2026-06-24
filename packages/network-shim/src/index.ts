/**
 * @sparklab/network-shim — Stage 6 network layering (3 tiers).
 *
 *   Tier 1 (fake)     — fully client-side, no backend (default; this file's exports).
 *   Tier 2 (mediated) — browser fetch/WebSocket proxy (CORS-aware) — added next.
 *   Tier 3 (gateway)  — real Internet via the egress-controlled gateway — requires the
 *                       user's VPS/domain (STOP per doctrine).
 *
 * The firmware's WiFi/HTTP HAL talks to a network MMIO peripheral, which delegates to one of
 * these tiers. The request/response shape is shared so a sketch is unchanged across tiers.
 */
export {
  WL_IDLE_STATUS,
  WL_CONNECTED,
  WL_DISCONNECTED,
  WiFiSim,
  FakeHttpServer,
  Tier1Network,
  parseHalRequest,
  type HttpRequest,
  type HttpResponse,
  type HttpHandler,
  type NetworkTransport,
} from './tier1-fake.js';
export { Tier2Network, type FetchFn, type FetchResponseLike } from './tier2-mediated.js';
export {
  FakeMqttBroker,
  type MqttTransport,
  type MqttMessage,
  type MqttSubscriber,
} from './mqtt.js';
export { Tier2Mqtt, type WebSocketLike, type WebSocketFactory } from './tier2-mqtt.js';
export {
  Tier3GatewayClient,
  type GatewaySocket,
  type GatewayFrame,
} from './tier3-gateway-client.js';
export {
  resolveNetworkConfig,
  DEFAULT_MQTT_WS_URL,
  PUBLIC_MQTT_WS_BROKERS,
  VIRTUAL_WIFI,
  type NetworkConfig,
} from './config.js';
export {
  FakeBlynkClient,
  Tier2BlynkClient,
  FakeBlynkServer,
  parseBlynkValue,
  parseBlynkError,
  type BlynkClient,
  type Tier2BlynkOpts,
} from './blynk-client.js';
export {
  FakeBlynkPresence,
  Tier2BlynkPresence,
  BLYNK_MQTT_URL,
  type BlynkPresence,
  type BlynkPresenceStatus,
} from './blynk-mqtt.js';
