import { describe, it, expect } from 'vitest';
import { RelaySession, type RelaySocket, type GatewayFrame, type SessionDeps } from './relay.js';
import { DEFAULT_POLICY, type GatewayEgressPolicy } from './egress.js';

class MockSocket implements RelaySocket {
  written: Uint8Array[] = [];
  ended = false;
  private dataCb: (d: Uint8Array) => void = () => {};
  private closeCb: () => void = () => {};
  write(d: Uint8Array): void {
    this.written.push(d);
  }
  end(): void {
    this.ended = true;
    this.closeCb();
  }
  onData(cb: (d: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  emitData(d: Uint8Array): void {
    this.dataCb(d);
  }
}

function harness(over: Partial<GatewayEgressPolicy> = {}, resolveTo: string[] = ['93.184.216.34']) {
  const policy: GatewayEgressPolicy = {
    ...DEFAULT_POLICY,
    allowlist: ['*.example.com', 'example.com', '8.8.8.8'],
    ...over,
  };
  const sent: GatewayFrame[] = [];
  const opened: { ip: string; port: number; sock: MockSocket }[] = [];
  let t = 0;
  const deps: SessionDeps = {
    policy,
    send: (f) => sent.push(f),
    connect: (ip, port) => {
      const sock = new MockSocket();
      opened.push({ ip, port, sock });
      return sock;
    },
    resolve: async () => resolveTo,
    now: () => t,
  };
  return { session: new RelaySession(deps), sent, opened, setTime: (v: number) => (t = v) };
}

describe('relay — happy path', () => {
  it('opens an allowed host, pumps data both ways, and closes', async () => {
    const h = harness();
    await h.session.handle({
      t: 'open',
      id: 1,
      proto: 'tcp',
      host: 'mqtt.example.com',
      port: 1883,
    });
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]!.ip).toBe('93.184.216.34'); // connected to the resolved+vetted IP
    expect(h.session.connectionCount).toBe(1);

    // client → server
    await h.session.handle({ t: 'data', id: 1, b: [0x10, 0x20] });
    expect(Array.from(h.opened[0]!.sock.written[0]!)).toEqual([0x10, 0x20]);

    // server → client
    h.opened[0]!.sock.emitData(Uint8Array.of(0xaa, 0xbb));
    expect(h.sent).toContainEqual({ t: 'data', id: 1, b: [0xaa, 0xbb] });

    await h.session.handle({ t: 'close', id: 1 });
    expect(h.opened[0]!.sock.ended).toBe(true);
    expect(h.session.connectionCount).toBe(0);
  });
});

describe('relay — egress enforcement', () => {
  it('rejects a host not in the allowlist (close frame, no socket)', async () => {
    const h = harness();
    await h.session.handle({ t: 'open', id: 7, proto: 'tcp', host: 'evil.net', port: 80 });
    expect(h.opened).toHaveLength(0);
    expect(h.sent).toEqual([{ t: 'close', id: 7 }]);
  });

  it('rejects a literal private/metadata IP even if allowlisted', async () => {
    const h = harness({ allowlist: ['169.254.169.254', '10.0.0.1'] });
    await h.session.handle({ t: 'open', id: 1, proto: 'tcp', host: '169.254.169.254', port: 80 });
    await h.session.handle({ t: 'open', id: 2, proto: 'tcp', host: '10.0.0.1', port: 80 });
    expect(h.opened).toHaveLength(0);
    expect(h.sent).toEqual([
      { t: 'close', id: 1 },
      { t: 'close', id: 2 },
    ]);
  });

  it('rejects a hostname that resolves to a private IP (DNS rebinding)', async () => {
    const h = harness({}, ['10.0.0.5']); // allowlisted name, but DNS points inside
    await h.session.handle({
      t: 'open',
      id: 3,
      proto: 'tcp',
      host: 'rebind.example.com',
      port: 443,
    });
    expect(h.opened).toHaveLength(0);
    expect(h.sent).toEqual([{ t: 'close', id: 3 }]);
  });

  it('rejects udp (tcp only)', async () => {
    const h = harness();
    await h.session.handle({ t: 'open', id: 9, proto: 'udp', host: 'example.com', port: 53 });
    expect(h.opened).toHaveLength(0);
  });
});

describe('relay — caps', () => {
  it('enforces max connections per session', async () => {
    const h = harness({ maxConnsPerSession: 2, connRatePerSecond: 100 });
    for (const id of [1, 2, 3])
      await h.session.handle({ t: 'open', id, proto: 'tcp', host: 'example.com', port: 80 });
    expect(h.opened).toHaveLength(2);
    expect(h.sent).toContainEqual({ t: 'close', id: 3 }); // third refused
  });

  it('closes a connection that exceeds the bandwidth cap', async () => {
    const h = harness({ bandwidthBytesPerSecond: 4 });
    await h.session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'example.com', port: 80 });
    await h.session.handle({ t: 'data', id: 1, b: [1, 2, 3, 4, 5] }); // 5 > 4
    expect(h.opened[0]!.sock.ended).toBe(true);
    expect(h.sent).toContainEqual({ t: 'close', id: 1 });
  });
});

describe('relay — session isolation', () => {
  it('a data frame on one session never touches another session’s socket', async () => {
    const a = harness();
    const b = harness();
    await a.session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'example.com', port: 80 });
    // session B never opened id 1 → its data is dropped, A is untouched
    await b.session.handle({ t: 'data', id: 1, b: [9, 9, 9] });
    expect(b.opened).toHaveLength(0);
    expect(a.opened[0]!.sock.written).toHaveLength(0);
  });
});

describe('relay — bidirectional limiter (AUD-021)', () => {
  it('caps a remote endpoint flood: inbound bytes over the cap close the connection, not forwarded', async () => {
    const h = harness({ bandwidthBytesPerSecond: 6 });
    await h.session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'example.com', port: 80 });
    const sock = h.opened[0]!.sock;
    sock.emitData(Uint8Array.of(1, 2, 3)); // 3 ≤ 6 → forwarded
    expect(h.sent).toContainEqual({ t: 'data', id: 1, b: [1, 2, 3] });
    sock.emitData(Uint8Array.of(4, 5, 6, 7)); // 3 + 4 = 7 > 6 → over inbound budget
    expect(h.sent).not.toContainEqual({ t: 'data', id: 1, b: [4, 5, 6, 7] }); // dropped
    expect(sock.ended).toBe(true); // connection closed
    expect(h.session.connectionCount).toBe(0);
  });
});

describe('relay — wall-clock reaping (AUD-021)', () => {
  it('enforceDeadline closes an idle session once its wall-clock budget is spent', async () => {
    let expired = false;
    let t = 0;
    const opened: MockSocket[] = [];
    const session = new RelaySession({
      policy: { ...DEFAULT_POLICY, allowlist: ['example.com'], sessionWallClockSeconds: 10 },
      send: () => {},
      connect: () => {
        const s = new MockSocket();
        opened.push(s);
        return s;
      },
      resolve: async () => ['93.184.216.34'],
      now: () => t,
      onExpire: () => (expired = true),
    });
    await session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'example.com', port: 80 });
    expect(session.enforceDeadline()).toBe(false); // still within budget
    t = 10_000; // wall-clock exceeded
    expect(session.enforceDeadline()).toBe(true);
    expect(expired).toBe(true);
    expect(session.connectionCount).toBe(0); // sockets torn down
    expect(opened[0]!.ended).toBe(true);
  });
});

describe('relay — socket lifecycle (AUD-022)', () => {
  it('rejects a duplicate open id without overwriting/leaking the live socket', async () => {
    const h = harness();
    await h.session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'example.com', port: 80 });
    const first = h.opened[0]!.sock;
    await h.session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'example.com', port: 80 });
    expect(h.opened).toHaveLength(1); // no second socket opened
    expect(h.sent).toContainEqual({ t: 'close', id: 1 }); // duplicate rejected
    expect(first.ended).toBe(false); // original left intact
    expect(h.session.connectionCount).toBe(1);
  });

  it('a close during a pending open leaves no zombie socket (AUD-022)', async () => {
    let release!: (ips: string[]) => void;
    const gate = new Promise<string[]>((r) => (release = r));
    const opened: MockSocket[] = [];
    const session = new RelaySession({
      policy: { ...DEFAULT_POLICY, allowlist: ['example.com'] },
      send: () => {},
      connect: () => {
        const s = new MockSocket();
        opened.push(s);
        return s;
      },
      resolve: () => gate, // open() awaits here until we release
      now: () => 0,
    });
    const openP = session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'example.com', port: 80 });
    await session.handle({ t: 'close', id: 1 }); // arrives while resolving
    release(['93.184.216.34']);
    await openP;
    expect(opened).toHaveLength(0); // cancelled before connect — no socket created
    expect(session.connectionCount).toBe(0);
  });

  it('an open that completes after destroy() is torn down, not registered', async () => {
    let release!: (ips: string[]) => void;
    const gate = new Promise<string[]>((r) => (release = r));
    const opened: MockSocket[] = [];
    const session = new RelaySession({
      policy: { ...DEFAULT_POLICY, allowlist: ['example.com'] },
      send: () => {},
      connect: () => {
        const s = new MockSocket();
        opened.push(s);
        return s;
      },
      resolve: () => gate,
      now: () => 0,
    });
    const openP = session.handle({ t: 'open', id: 1, proto: 'tcp', host: 'example.com', port: 80 });
    session.destroy();
    release(['93.184.216.34']);
    await openP;
    expect(session.connectionCount).toBe(0);
    expect(opened).toHaveLength(0);
  });
});
