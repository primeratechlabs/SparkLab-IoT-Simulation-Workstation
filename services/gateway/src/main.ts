/**
 * Stage 6 — gateway entry point. Reads config from the environment (see .env.example) and starts
 * the relay. Run on YOUR host/VPS:  `node --experimental-strip-types src/main.ts`  (or via Docker).
 *
 * Required for any real use: set GATEWAY_ALLOWLIST (default-deny — empty reaches nothing) and a
 * GATEWAY_TOKEN. Egress hardening (block private/metadata, caps) is on by default.
 */
import { startGateway } from './server.js';
import { DEFAULT_POLICY, type GatewayEgressPolicy } from './egress.js';

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const policy: GatewayEgressPolicy = {
  allowlist: (process.env.GATEWAY_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  denyPrivateRanges: process.env.GATEWAY_ALLOW_PRIVATE !== '1', // ON unless explicitly disabled
  dnsRebindProtection: true,
  maxConnsPerSession: num('GATEWAY_MAX_CONNS', DEFAULT_POLICY.maxConnsPerSession),
  connRatePerSecond: num('GATEWAY_CONN_RATE', DEFAULT_POLICY.connRatePerSecond),
  bandwidthBytesPerSecond: num('GATEWAY_BANDWIDTH', DEFAULT_POLICY.bandwidthBytesPerSecond),
  sessionWallClockSeconds: num('GATEWAY_SESSION_SECONDS', DEFAULT_POLICY.sessionWallClockSeconds),
};

const port = num('GATEWAY_PORT', 9000);
const authToken = process.env.GATEWAY_TOKEN || undefined;

if (policy.allowlist.length === 0) {
  console.warn(
    '[gateway] WARNING: GATEWAY_ALLOWLIST is empty → default-deny, nothing is reachable. Set it (e.g. "broker.emqx.io,*.hivemq.com").',
  );
}
if (!authToken) {
  console.warn(
    '[gateway] WARNING: no GATEWAY_TOKEN set → anyone who can reach the port can use the relay. Set one before exposing publicly.',
  );
}

void startGateway({ port, policy, authToken, log: (m) => console.log(`[gateway] ${m}`) }).then(
  (gw) => {
    console.log(
      `[gateway] ready on :${gw.port}  allowlist=[${policy.allowlist.join(', ') || '(empty — deny all)'}]`,
    );
  },
);
