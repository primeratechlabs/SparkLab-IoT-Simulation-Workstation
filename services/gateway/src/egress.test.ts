import { describe, it, expect } from 'vitest';
import {
  isPrivateOrReservedIp,
  hostMatchesAllowlist,
  checkHostAllowed,
  checkResolvedIp,
  parseIpv4,
  SessionLimiter,
  DEFAULT_POLICY,
  type GatewayEgressPolicy,
} from './egress.js';

describe('egress — private/reserved IP classification (anti-SSRF)', () => {
  it('blocks private, loopback, link-local and the cloud metadata address', () => {
    for (const ip of [
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.1.1',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.0.1',
      '169.254.169.254', // ← cloud metadata
      '100.64.0.1',
      '192.0.0.1',
      '192.0.2.5',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateOrReservedIp(ip), `${ip} must be blocked`).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '13.107.42.14',
      '93.184.216.34',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
    ]) {
      expect(isPrivateOrReservedIp(ip), `${ip} must be allowed`).toBe(false);
    }
  });

  it('parseIpv4 rejects out-of-range / non-IPv4', () => {
    expect(parseIpv4('1.2.3.4')).toEqual([1, 2, 3, 4]);
    expect(parseIpv4('256.0.0.1')).toBeNull();
    expect(parseIpv4('example.com')).toBeNull();
  });
});

describe('egress — allowlist matching (default-deny)', () => {
  it('empty allowlist denies everything; exact + wildcard match', () => {
    expect(hostMatchesAllowlist('broker.emqx.io', [])).toBe(false);
    expect(hostMatchesAllowlist('broker.emqx.io', ['broker.emqx.io'])).toBe(true);
    expect(hostMatchesAllowlist('a.hivemq.com', ['*.hivemq.com'])).toBe(true);
    expect(hostMatchesAllowlist('hivemq.com', ['*.hivemq.com'])).toBe(true);
    expect(hostMatchesAllowlist('evil.com', ['*.hivemq.com'])).toBe(false);
    expect(hostMatchesAllowlist('anything.net', ['*'])).toBe(true);
  });

  it('checkHostAllowed enforces allowlist then literal-IP private block', () => {
    const policy: GatewayEgressPolicy = {
      ...DEFAULT_POLICY,
      allowlist: ['broker.emqx.io', '8.8.8.8', '169.254.169.254'],
    };
    expect(checkHostAllowed('broker.emqx.io', policy).ok).toBe(true);
    expect(checkHostAllowed('8.8.8.8', policy).ok).toBe(true);
    expect(checkHostAllowed('not-listed.com', policy).ok).toBe(false); // allowlist
    expect(checkHostAllowed('169.254.169.254', policy).ok).toBe(false); // allowlisted but still a blocked IP
  });

  it('checkResolvedIp blocks a hostname that resolves to a private IP (DNS rebinding)', () => {
    expect(checkResolvedIp('10.0.0.5', DEFAULT_POLICY).ok).toBe(false);
    expect(checkResolvedIp('8.8.8.8', DEFAULT_POLICY).ok).toBe(true);
  });
});

describe('egress — SessionLimiter (caps, injectable clock)', () => {
  const policy: GatewayEgressPolicy = {
    ...DEFAULT_POLICY,
    maxConnsPerSession: 2,
    connRatePerSecond: 3,
    bandwidthBytesPerSecond: 100,
    sessionWallClockSeconds: 5,
  };

  it('enforces max concurrent connections', () => {
    const t = 0;
    const lim = new SessionLimiter(policy, () => t);
    expect(lim.canOpen().ok).toBe(true);
    lim.countOpen();
    expect(lim.canOpen().ok).toBe(true);
    lim.countOpen();
    expect(lim.canOpen().ok).toBe(false); // 2 open already
    lim.countClose();
    expect(lim.canOpen().ok).toBe(true);
  });

  it('enforces connection rate per second and resets each second', () => {
    let t = 0;
    const lim = new SessionLimiter(policy, () => t);
    for (let i = 0; i < 3; i++) {
      expect(lim.canOpen().ok).toBe(true);
      lim.countOpen();
      lim.countClose();
    }
    expect(lim.canOpen().ok).toBe(false); // 4th in the same second
    t = 1000; // next window
    expect(lim.canOpen().ok).toBe(true);
  });

  it('enforces bandwidth per second', () => {
    let t = 0;
    const lim = new SessionLimiter(policy, () => t);
    expect(lim.canSend(80).ok).toBe(true);
    lim.countSend(80);
    expect(lim.canSend(30).ok).toBe(false); // 80 + 30 > 100
    t = 1000;
    expect(lim.canSend(80).ok).toBe(true); // window reset
  });

  it('expires the session after the wall-clock budget', () => {
    let t = 0;
    const lim = new SessionLimiter(policy, () => t);
    expect(lim.canOpen().ok).toBe(true);
    t = 5000; // 5s
    expect(lim.canOpen().ok).toBe(false);
    expect(lim.canSend(1).ok).toBe(false);
  });
});
