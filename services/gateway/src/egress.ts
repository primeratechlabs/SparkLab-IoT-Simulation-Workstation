/**
 * Stage 6 — gateway egress controls (the security core). A gateway opens real sockets on behalf
 * of browser clients, so without these it is an open proxy / SSRF vector: an attacker could reach
 * the host's own internal network or the cloud metadata endpoint (169.254.169.254 → credential
 * theft). Every outbound connection is gated by: a default-deny allowlist, private/reserved-IP
 * blocking, DNS-rebind protection (connect to the vetted resolved IP), and per-session
 * connection/rate/bandwidth/wall-clock caps. Pure logic — fully unit-tested, no I/O.
 */

export interface GatewayEgressPolicy {
  allowlist: string[]; // host patterns; empty = deny all; '*' = allow any host (still IP-checked)
  denyPrivateRanges: boolean; // block RFC1918 / loopback / link-local / metadata
  dnsRebindProtection: boolean; // connect to the resolved+vetted IP, not a re-resolved one
  maxConnsPerSession: number;
  connRatePerSecond: number;
  bandwidthBytesPerSecond: number;
  sessionWallClockSeconds: number;
}

export const DEFAULT_POLICY: GatewayEgressPolicy = {
  allowlist: [], // default-deny: nothing is reachable until you configure GATEWAY_ALLOWLIST
  denyPrivateRanges: true,
  dnsRebindProtection: true,
  maxConnsPerSession: 8,
  connRatePerSecond: 5,
  bandwidthBytesPerSecond: 1_000_000,
  sessionWallClockSeconds: 600,
};

export interface EgressCheck {
  ok: boolean;
  reason?: string;
}

/** Parse a dotted-quad IPv4 to octets, or null if not an IPv4 literal. */
export function parseIpv4(ip: string): [number, number, number, number] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [
    number,
    number,
    number,
    number,
  ];
  return o.some((x) => x > 255) ? null : o;
}

/** True if an IP literal is private, loopback, link-local (incl. cloud metadata), or otherwise reserved. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i); // IPv4-mapped IPv6
  const v4 = parseIpv4(mapped ? mapped[1]! : ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (TEST-NET-1)
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255
    return false;
  }
  const x = ip.toLowerCase();
  if (x === '::1' || x === '::') return true; // loopback / unspecified
  if (x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (x.startsWith('fc') || x.startsWith('fd')) return true; // fc00::/7 unique-local
  if (x.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

/** Match a host against an allowlist of exact names, '*' (any), or '*.suffix' wildcards. */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const p = raw.toLowerCase().trim();
    if (!p) continue;
    if (p === '*') return true;
    if (p.startsWith('*.')) {
      if (h === p.slice(2) || h.endsWith(p.slice(1))) return true; // a.example.com or example.com
    } else if (p === h) return true;
  }
  return false;
}

/** Gate a requested host (before DNS): allowlist + literal-IP private check. */
export function checkHostAllowed(host: string, policy: GatewayEgressPolicy): EgressCheck {
  if (!hostMatchesAllowlist(host, policy.allowlist)) {
    return { ok: false, reason: `host not in allowlist: ${host}` };
  }
  if (
    policy.denyPrivateRanges &&
    (parseIpv4(host) || host.includes(':')) &&
    isPrivateOrReservedIp(host)
  ) {
    return { ok: false, reason: `blocked private/reserved address: ${host}` };
  }
  return { ok: true };
}

/** Gate a resolved IP (after DNS) — the actual address we will connect to. */
export function checkResolvedIp(ip: string, policy: GatewayEgressPolicy): EgressCheck {
  if (policy.denyPrivateRanges && isPrivateOrReservedIp(ip)) {
    return { ok: false, reason: `resolved to private/reserved IP: ${ip}` };
  }
  return { ok: true };
}

/** Per-session connection / rate / bandwidth / wall-clock budget. Clock is injectable for tests. */
export class SessionLimiter {
  private openConns = 0;
  private windowStart: number;
  private connsInWindow = 0;
  private bytesInWindow = 0; // client → remote (upload)
  private bytesRecvInWindow = 0; // remote → client (download) — metered separately so a remote flood is capped (AUD-021)
  private readonly startedAt: number;

  constructor(
    private readonly policy: GatewayEgressPolicy,
    private readonly now: () => number,
  ) {
    this.startedAt = now();
    this.windowStart = now();
  }

  private roll(): void {
    const t = this.now();
    if (t - this.windowStart >= 1000) {
      this.windowStart = t;
      this.connsInWindow = 0;
      this.bytesInWindow = 0;
      this.bytesRecvInWindow = 0;
    }
  }

  expired(): boolean {
    return this.now() - this.startedAt >= this.policy.sessionWallClockSeconds * 1000;
  }

  canOpen(): EgressCheck {
    if (this.expired()) return { ok: false, reason: 'session wall-clock exceeded' };
    if (this.openConns >= this.policy.maxConnsPerSession)
      return { ok: false, reason: 'max connections per session' };
    this.roll();
    if (this.connsInWindow >= this.policy.connRatePerSecond)
      return { ok: false, reason: 'connection rate exceeded' };
    return { ok: true };
  }
  countOpen(): void {
    this.openConns++;
    this.roll();
    this.connsInWindow++;
  }
  countClose(): void {
    if (this.openConns > 0) this.openConns--;
  }
  canSend(bytes: number): EgressCheck {
    if (this.expired()) return { ok: false, reason: 'session wall-clock exceeded' };
    this.roll();
    if (this.bytesInWindow + bytes > this.policy.bandwidthBytesPerSecond)
      return { ok: false, reason: 'bandwidth exceeded' };
    return { ok: true };
  }
  countSend(bytes: number): void {
    this.roll();
    this.bytesInWindow += bytes;
  }
  /** Inbound (remote → client) budget check — same per-second cap, counted separately (AUD-021). */
  canRecv(bytes: number): EgressCheck {
    if (this.expired()) return { ok: false, reason: 'session wall-clock exceeded' };
    this.roll();
    if (this.bytesRecvInWindow + bytes > this.policy.bandwidthBytesPerSecond) {
      return { ok: false, reason: 'inbound bandwidth exceeded' };
    }
    return { ok: true };
  }
  countRecv(bytes: number): void {
    this.roll();
    this.bytesRecvInWindow += bytes;
  }
  get connections(): number {
    return this.openConns;
  }
}
