/**
 * Stage 6 — Tier 2 network shim (MEDIATED). The firmware's request is carried out over the
 * browser's own `fetch` (or any injected fetch-like function), so a sketch reaches the REAL
 * Internet client-side — no Sparklab backend, no gateway. Subject to the browser's CORS rules:
 * the target must allow the origin (many public test APIs do, e.g. httpbin / postman-echo).
 *
 * This is async (a real network round-trip), so the MMIO peripheral latches the response when
 * the promise resolves and the firmware spins on the HTTP_READY register meanwhile (virtual-time
 * still governs the sketch's delay()s). WiFi keeps the same simulated connect handshake as Tier 1
 * for teaching continuity. backend_compile_count is still 0 (I8) — this is transport, not compile.
 */
import {
  WiFiSim,
  WL_CONNECTED,
  type HttpRequest,
  type HttpResponse,
  type NetworkTransport,
} from './tier1-fake.js';

/** Is `host` a loopback / private / link-local / mDNS target the real tier must refuse (AUD-025)? Best
 *  effort by name+literal (the browser still applies its own CORS/PNA on top). */
export function isPrivateHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // localhost + literal private/loopback IPs are clear SSRF; mDNS .local resolves to a local IP that the
  // browser's Private-Network-Access already gates, so we don't block it by name here.
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (
    h === '::1' ||
    h === '0.0.0.0' ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    h.startsWith('fe80:')
  )
    return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true; // loopback / private / this-host
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}

/** Minimal shape of the `fetch` Response we use (compatible with the DOM/Node global fetch). */
export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
}
export type FetchFn = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

export class Tier2Network implements NetworkTransport {
  readonly wifi: WiFiSim;
  private readonly fetchFn: FetchFn;
  /** Every URL actually requested (for tests / inspector). */
  readonly calls: { url: string; method: string; body: string }[] = [];
  /** The last HTTP failure (a thrown CORS/network error, or a non-2xx status), or null. Surfaced to the
   *  UI so a CORS block / invalid token / dead host is reported, not collapsed into a silent "no data". */
  lastError: string | null = null;

  constructor(opts: { fetchFn?: FetchFn; connectPolls?: number } = {}) {
    this.wifi = new WiFiSim(opts.connectPolls);
    const f = opts.fetchFn ?? (globalThis as { fetch?: FetchFn }).fetch;
    if (!f) throw new Error('Tier2Network: no fetch available (pass opts.fetchFn)');
    // The native `fetch` MUST be invoked with `this` === the global scope; calling it as a method
    // (`this.fetchFn(...)`) throws "Illegal invocation" in a Worker. Bind it to globalThis so the call
    // site is always safe. (An injected arrow-function stub ignores the bind — harmless.)
    this.fetchFn = f.bind(globalThis) as FetchFn;
  }

  /** Build the absolute URL from the firmware's host:port + path (443 → https). */
  url(req: HttpRequest): string {
    const scheme = req.port === 443 ? 'https' : 'http';
    const portPart = req.port === 80 || req.port === 443 ? '' : `:${req.port}`;
    return `${scheme}://${req.host}${portPart}${req.path}`;
  }

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    if (this.wifi.status() !== WL_CONNECTED) return { status: 0, body: '' };
    // SSRF guard (AUD-025): the SKETCH controls host/path, so on the real tier an untrusted firmware must
    // NOT be able to reach localhost or a private/internal network from the user's browser. Block them.
    if (isPrivateHost(req.host)) {
      this.lastError = `Bị chặn: firmware cố truy cập địa chỉ nội bộ/riêng tư (${req.host}).`;
      return { status: 0, body: '' };
    }
    const url = this.url(req);
    this.calls.push({ url, method: req.method, body: req.body });
    try {
      const r = await this.fetchFn(url, {
        method: req.method,
        body: req.method === 'GET' ? undefined : req.body,
      });
      const body = await r.text();
      // Record a non-2xx so the UI can explain it (e.g. Blynk 400 = invalid token) instead of the firmware
      // silently skipping it. 2xx clears the last error.
      this.lastError =
        r.status >= 200 && r.status < 300
          ? null
          : `${req.host} trả HTTP ${r.status}${r.status === 400 ? ' (token Blynk không hợp lệ?)' : ''}`;
      return { status: r.status, body };
    } catch (e) {
      // A thrown error is a CORS block / network failure — distinct from "no wifi" (status 0 above). Make
      // it visible rather than collapsing it into a silent no-connection (audit P0).
      this.lastError = `Trình duyệt không gọi được ${req.host} — bị CORS chặn hoặc lỗi mạng (${e instanceof Error ? e.message : 'fetch failed'})`;
      return { status: 0, body: '' };
    }
  }
}
