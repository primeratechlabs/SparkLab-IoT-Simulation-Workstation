/**
 * Stage 6 — Tier 1 network shim (FAKE, fully client-side, NO backend by default, I8).
 *
 * The default tier for teaching: `WiFi.begin()` reaches a simulated "connected" state and a
 * local fake HTTP server answers requests — enough to exercise sketch network logic (connect,
 * send a sensor value, receive a command back) without touching the real Internet. This is the
 * host-side truth the emulator's network MMIO peripheral delegates to (firmware HAL → MMIO →
 * here). Tier 2 (browser-mediated fetch/WebSocket) and Tier 3 (real Internet via gateway) layer
 * on the same request/response shape.
 *
 * Deterministic: connection completes after a fixed number of polls (virtual-time friendly),
 * and request handling is a pure function of the registered routes — so a run is reproducible.
 */

/** arduino-esp32 wl_status_t subset (WiFiType.h). */
export const WL_IDLE_STATUS = 0;
export const WL_CONNECTED = 3;
export const WL_DISCONNECTED = 6;

export interface HttpRequest {
  method: string;
  host: string;
  port: number;
  path: string;
  body: string;
}
export interface HttpResponse {
  status: number;
  body: string;
}
export type HttpHandler = (req: HttpRequest) => HttpResponse;

/**
 * What the network MMIO peripheral talks to, independent of tier. `wifi` drives the connect
 * handshake; `fetch` performs one request — synchronously (Tier 1 fake) or asynchronously
 * (Tier 2 browser fetch / Tier 3 gateway). The peripheral handles both shapes.
 */
export interface NetworkTransport {
  readonly wifi: WiFiSim;
  fetch(req: HttpRequest): HttpResponse | Promise<HttpResponse>;
}

/**
 * Simulated WiFi station. `begin()` starts a connect; each `poll()` advances one step; after
 * `connectPolls` polls the link is up. Mirrors how a sketch spins `while (WiFi.status() !=
 * WL_CONNECTED) delay(...)` — here the spin terminates deterministically.
 */
export class WiFiSim {
  private state: number = WL_IDLE_STATUS;
  private polls = 0;
  private ssid = '';
  /** Assigned station IP once connected (DHCP-style, fixed for reproducibility). */
  readonly localIp = '192.168.4.2';

  constructor(private readonly connectPolls = 3) {}

  begin(ssid: string): void {
    this.ssid = ssid;
    this.state = WL_DISCONNECTED;
    this.polls = 0;
  }
  /** Advance the connect state machine one step (called when the firmware reads status). */
  poll(): void {
    if (this.state === WL_DISCONNECTED && ++this.polls >= this.connectPolls) {
      this.state = WL_CONNECTED;
    }
  }
  status(): number {
    return this.state;
  }
  connectedSsid(): string {
    return this.state === WL_CONNECTED ? this.ssid : '';
  }
  disconnect(): void {
    this.state = WL_DISCONNECTED;
    this.polls = 0;
  }
}

/**
 * Tier-1 fake HTTP server. Routes are matched by `host` (+ optional path prefix); the matching
 * handler turns a request into a response. Records every request for test assertions. With no
 * matching route, a default echo handler returns `200` and the request body — so a round-trip
 * always works out of the box.
 */
export class FakeHttpServer {
  private routes: { host: string; pathPrefix: string; handler: HttpHandler }[] = [];
  readonly requests: HttpRequest[] = [];
  readonly responses: HttpResponse[] = [];

  /** Register a handler for a host (and optional path prefix). Most specific prefix wins. */
  route(host: string, handler: HttpHandler, pathPrefix = ''): this {
    this.routes.push({ host, pathPrefix, handler });
    return this;
  }

  handle(req: HttpRequest): HttpResponse {
    this.requests.push(req);
    const match = this.routes
      .filter((r) => r.host === req.host && req.path.startsWith(r.pathPrefix))
      .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
    const res = match ? match.handler(req) : { status: 200, body: req.body };
    this.responses.push(res);
    return res;
  }

  /** The most recent request, or undefined. */
  lastRequest(): HttpRequest | undefined {
    return this.requests[this.requests.length - 1];
  }
}

/**
 * Tier-1 facade the emulator's network peripheral talks to: a WiFi station + a fake HTTP server.
 * One request = one `fetch()` call; the firmware HAL streams the request bytes in and the
 * response bytes out via MMIO.
 */
export class Tier1Network {
  readonly wifi: WiFiSim;
  readonly server: FakeHttpServer;

  constructor(opts: { connectPolls?: number; server?: FakeHttpServer } = {}) {
    this.wifi = new WiFiSim(opts.connectPolls);
    this.server = opts.server ?? new FakeHttpServer();
  }

  /** Process one HTTP request against the fake server (only when WiFi is up). */
  fetch(req: HttpRequest): HttpResponse {
    if (this.wifi.status() !== WL_CONNECTED) return { status: 0, body: '' }; // not connected
    return this.server.handle(req);
  }
}

/**
 * Parse the minimal request line the firmware HAL writes:  `METHOD host:port path\nbody`.
 * Keeps the MMIO contract tiny (no full HTTP framing in tier 1).
 */
export function parseHalRequest(raw: string): HttpRequest {
  const nl = raw.indexOf('\n');
  const line = nl >= 0 ? raw.slice(0, nl) : raw;
  const body = nl >= 0 ? raw.slice(nl + 1) : '';
  const [method = 'GET', target = '', path = '/'] = line.split(' ');
  const [host = '', portStr = '80'] = target.split(':');
  return { method, host, port: Number(portStr) || 80, path, body };
}
