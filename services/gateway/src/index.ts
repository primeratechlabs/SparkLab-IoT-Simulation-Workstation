/**
 * @sparklab/gateway — Stage 6 Tier-3 relay (WebSocket ↔ raw TCP/TLS), with egress hardening.
 * Self-hostable on your VPS; the browser connects to it only when a sketch must reach a service
 * that has no WebSocket/CORS path (e.g. a TCP-only MQTT broker on :1883). It NEVER compiles
 * anything (backend_compile_count stays 0) and only relays opaque bytes (TLS terminates in the
 * firmware).
 */
export {
  DEFAULT_POLICY,
  isPrivateOrReservedIp,
  hostMatchesAllowlist,
  checkHostAllowed,
  checkResolvedIp,
  parseIpv4,
  SessionLimiter,
  type GatewayEgressPolicy,
  type EgressCheck,
} from './egress.js';
export {
  RelaySession,
  type GatewayFrame,
  type RelaySocket,
  type SocketConnector,
  type Resolver,
  type SessionDeps,
} from './relay.js';
export { startGateway, type GatewayServerOptions, type RunningGateway } from './server.js';
