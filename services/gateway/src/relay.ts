/**
 * Stage 6 — gateway relay session. One WebSocket client = one RelaySession with its OWN socket
 * map + limiter (session isolation: a frame from one session can never touch another's sockets).
 * It multiplexes virtual L4 connections (GatewayFrame open/data/close) onto real TCP sockets,
 * gating every open through the egress policy and every byte through the bandwidth cap. The TCP
 * connector + DNS resolver + clock are injected, so the whole thing is unit-tested without I/O.
 *
 * TLS terminates in the FIRMWARE (the `b` payloads are opaque — possibly TLS records); the
 * gateway only relays ciphertext and never sees plaintext.
 */
import {
  checkHostAllowed,
  checkResolvedIp,
  parseIpv4,
  SessionLimiter,
  type GatewayEgressPolicy,
} from './egress.js';

/** Client<->gateway frame (mirrors the gateway protocol GatewayFrame). */
export type GatewayFrame =
  | { t: 'open'; id: number; proto: 'tcp' | 'udp'; host: string; port: number }
  | { t: 'data'; id: number; b: number[] }
  | { t: 'close'; id: number };

export interface RelaySocket {
  write(data: Uint8Array): void;
  end(): void;
  onData(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
}
export type SocketConnector = (ip: string, port: number) => RelaySocket;
export type Resolver = (host: string) => Promise<string[]>;

export interface SessionDeps {
  policy: GatewayEgressPolicy;
  send: (frame: GatewayFrame) => void; // → the WS client
  connect: SocketConnector; // open a real (already IP-vetted) TCP socket
  resolve: Resolver; // DNS lookup → candidate IPs
  now: () => number;
  log?: (msg: string) => void; // audit log
  onExpire?: () => void; // called once when the session self-closes on wall-clock expiry (server closes the WS)
}

export class RelaySession {
  private readonly sockets = new Map<number, RelaySocket>();
  // Connection ids whose open() is in flight (DNS/connect pending). A `close` for a pending id flips its
  // token's `cancelled`, so the open tears the socket down on completion instead of leaking it (AUD-022).
  private readonly pending = new Map<number, { cancelled: boolean }>();
  private readonly limiter: SessionLimiter;
  private destroyed = false;

  constructor(private readonly deps: SessionDeps) {
    this.limiter = new SessionLimiter(deps.policy, deps.now);
  }

  async handle(frame: GatewayFrame): Promise<void> {
    if (frame.t === 'open') return this.open(frame);
    if (frame.t === 'data') return this.data(frame);
    if (frame.t === 'close') return this.closeId(frame.id);
  }

  private async open(f: Extract<GatewayFrame, { t: 'open' }>): Promise<void> {
    // Duplicate id: a second open for an id already live or in flight is rejected, never silently
    // overwriting (and leaking) the existing socket (AUD-022).
    if (this.sockets.has(f.id) || this.pending.has(f.id)) {
      return this.reject(f.id, 'connection id already in use');
    }

    const cap = this.limiter.canOpen();
    if (!cap.ok) return this.reject(f.id, cap.reason!);
    if (f.proto !== 'tcp') return this.reject(f.id, 'only tcp is supported');

    const hostCheck = checkHostAllowed(f.host, this.deps.policy);
    if (!hostCheck.ok) return this.reject(f.id, hostCheck.reason!);

    // Mark in-flight so a concurrent close (during the DNS await below) can cancel this open.
    const token = { cancelled: false };
    this.pending.set(f.id, token);

    // Determine the exact IP to connect to (DNS-rebind protection: vet, then connect to THAT ip).
    let ip = f.host;
    const isLiteral = parseIpv4(f.host) !== null || f.host.includes(':');
    if (!isLiteral) {
      let ips: string[];
      try {
        ips = await this.deps.resolve(f.host);
      } catch {
        this.pending.delete(f.id);
        return this.reject(f.id, 'dns resolution failed');
      }
      const vetted = ips.find((i) => checkResolvedIp(i, this.deps.policy).ok);
      if (!vetted) {
        this.pending.delete(f.id);
        return this.reject(f.id, 'all resolved addresses blocked');
      }
      ip = vetted;
    } else {
      const ipCheck = checkResolvedIp(f.host, this.deps.policy);
      if (!ipCheck.ok) {
        this.pending.delete(f.id);
        return this.reject(f.id, ipCheck.reason!);
      }
    }

    // Closed (or session destroyed) while we were resolving → abandon the open before any socket exists
    // (no countOpen yet, so nothing to balance). This kills the zombie-socket race (AUD-022).
    if (token.cancelled || this.destroyed) {
      this.pending.delete(f.id);
      return;
    }

    this.limiter.countOpen();
    let sock: RelaySocket;
    try {
      sock = this.deps.connect(ip, f.port);
    } catch (e) {
      this.limiter.countClose();
      this.pending.delete(f.id);
      return this.reject(f.id, `connect failed: ${(e as Error).message}`);
    }

    // A close could have arrived synchronously between the cancel check and connect; if so, tear the
    // freshly-opened socket down immediately instead of registering it.
    if (token.cancelled || this.destroyed) {
      this.pending.delete(f.id);
      this.limiter.countClose();
      try {
        sock.end();
      } catch {
        /* best-effort teardown */
      }
      return;
    }

    this.pending.delete(f.id);
    this.sockets.set(f.id, sock);
    this.deps.log?.(`open id=${f.id} ${f.host}:${f.port} → ${ip}`);
    sock.onData((d) => {
      // Meter the inbound direction too, so a remote endpoint flooding the client is capped (AUD-021).
      const recv = this.limiter.canRecv(d.length);
      if (!recv.ok) return this.closeId(f.id, recv.reason);
      this.limiter.countRecv(d.length);
      this.deps.send({ t: 'data', id: f.id, b: Array.from(d) });
    });
    sock.onClose(() => {
      if (this.sockets.delete(f.id)) {
        this.limiter.countClose();
        this.deps.send({ t: 'close', id: f.id });
      }
    });
  }

  private data(f: Extract<GatewayFrame, { t: 'data' }>): void {
    const sock = this.sockets.get(f.id);
    if (!sock) return; // unknown / closed connection — drop
    const bytes = Uint8Array.from(f.b);
    const cap = this.limiter.canSend(bytes.length);
    if (!cap.ok) return this.closeId(f.id, cap.reason);
    this.limiter.countSend(bytes.length);
    sock.write(bytes);
  }

  private closeId(id: number, reason?: string): void {
    // If an open() for this id is still in flight, flag it cancelled so it tears itself down on
    // completion rather than registering a socket nobody will ever close (AUD-022).
    const pend = this.pending.get(id);
    if (pend) pend.cancelled = true;
    const sock = this.sockets.get(id);
    if (sock) {
      sock.end();
      this.sockets.delete(id);
      this.limiter.countClose();
    }
    if (reason) this.deps.log?.(`close id=${id} ${reason}`);
  }

  /**
   * Proactively close the whole session if its wall-clock budget is spent (AUD-021). The server calls
   * this on a timer so an idle-but-existing session is reaped even with no open/send traffic to trigger
   * the per-frame check. Returns true if it expired (and was destroyed).
   */
  enforceDeadline(): boolean {
    if (this.destroyed) return true;
    if (!this.limiter.expired()) return false;
    this.deps.log?.('session wall-clock exceeded — closing');
    this.destroy();
    this.deps.onExpire?.();
    return true;
  }

  private reject(id: number, reason: string): void {
    this.deps.log?.(`reject id=${id} ${reason}`);
    this.deps.send({ t: 'close', id }); // tell the client this connection failed / no longer exists
  }

  /** Active virtual connections (for tests/metrics). */
  get connectionCount(): number {
    return this.sockets.size;
  }

  destroy(): void {
    if (this.destroyed) return; // idempotent cleanup (AUD-022)
    this.destroyed = true;
    // Cancel any in-flight opens so a socket that connects after destroy() is torn down, not leaked.
    for (const tok of this.pending.values()) tok.cancelled = true;
    for (const id of [...this.sockets.keys()]) this.closeId(id);
  }
}
