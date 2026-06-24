/**
 * Stage 7 — multi-CCU for the gateway. Many concurrent users = many RelaySessions. Each session
 * is isolated (its own socket map + limiter), so one tenant can neither see another's traffic nor
 * starve them by exhausting its own caps. Hermetic (mock connector), CI-runnable.
 */
import { describe, it, expect } from 'vitest';
import { RelaySession, type RelaySocket, type GatewayFrame, type SessionDeps } from './relay.js';
import { DEFAULT_POLICY, type GatewayEgressPolicy } from './egress.js';

class MockSocket implements RelaySocket {
  written: Uint8Array[] = [];
  ended = false;
  private onCloseCb: () => void = () => {};
  write(d: Uint8Array): void {
    this.written.push(d);
  }
  end(): void {
    this.ended = true;
    this.onCloseCb();
  }
  onData(): void {}
  onClose(cb: () => void): void {
    this.onCloseCb = cb;
  }
}

function makeSession(over: Partial<GatewayEgressPolicy> = {}) {
  const policy: GatewayEgressPolicy = { ...DEFAULT_POLICY, allowlist: ['*'], ...over };
  const sent: GatewayFrame[] = [];
  const opened: { ip: string; port: number; sock: MockSocket }[] = [];
  const deps: SessionDeps = {
    policy,
    send: (f) => sent.push(f),
    connect: (ip, port) => {
      const sock = new MockSocket();
      opened.push({ ip, port, sock });
      return sock;
    },
    resolve: async () => ['93.184.216.34'], // a public IP (passes egress)
    now: () => 0,
  };
  return { session: new RelaySession(deps), sent, opened };
}

describe('gateway — multi-CCU (concurrent sessions)', () => {
  it('N concurrent sessions: data on one never reaches another session’s socket', async () => {
    const N = 32;
    const sessions = Array.from({ length: N }, () => makeSession());
    for (const s of sessions)
      await s.session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'a.example.com', port: 80 });
    for (let i = 0; i < N; i++)
      await sessions[i]!.session.handle({ t: 'data', id: 1, b: [i & 0xff] });

    for (let i = 0; i < N; i++) {
      expect(sessions[i]!.opened).toHaveLength(1);
      expect(Array.from(sessions[i]!.opened[0]!.sock.written[0]!)).toEqual([i & 0xff]); // only its own byte
    }
  });

  it('per-session caps are independent — one user maxing out does not affect others', async () => {
    const maxConns = 3;
    const a = makeSession({ maxConnsPerSession: maxConns, connRatePerSecond: 100 });
    const b = makeSession({ maxConnsPerSession: maxConns, connRatePerSecond: 100 });

    for (let id = 1; id <= maxConns + 2; id++)
      await a.session.handle({ t: 'open', id, proto: 'tcp', host: 'a.example.com', port: 80 });
    expect(a.opened).toHaveLength(maxConns); // A capped

    for (let id = 1; id <= maxConns; id++)
      await b.session.handle({ t: 'open', id, proto: 'tcp', host: 'b.example.com', port: 80 });
    expect(b.opened).toHaveLength(maxConns); // B unaffected — full quota available
  });

  it('destroying one session tears down only its own connections', async () => {
    const a = makeSession();
    const b = makeSession();
    await a.session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'a.example.com', port: 80 });
    await b.session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'b.example.com', port: 80 });

    a.session.destroy();
    expect(a.opened[0]!.sock.ended).toBe(true);
    expect(b.opened[0]!.sock.ended).toBe(false); // B's connection survives
    expect(b.session.connectionCount).toBe(1);
  });
});
