/**
 * Blynk Device HTTPS API client — the IoT-dashboard teaching path, client-side (invariant I8: no
 * backend, no server compile). Two tiers behind ONE interface so a sketch/UI is unchanged across them:
 *
 *   FakeBlynkClient  — Tier 1, deterministic + offline: an in-memory virtual-pin store that mirrors how
 *                      the Blynk cloud round-trips V-pin reads/writes. Drives all unit tests + an
 *                      offline lesson with no account or egress.
 *   Tier2BlynkClient — Tier 2, the REAL Blynk cloud over the browser's fetch (CORS-readable from the app
 *                      origin, per the manual retest). The user supplies a device token at runtime.
 *
 * Blynk's HTTP API (verified routes): GET /external/api/get?token=..&V{n} → value, GET
 * /external/api/update?token=..&V{n}={value} → "1", GET /external/api/isHardwareConnected?token=.. →
 * "true"/"false". An invalid token returns HTTP 400 {"error":{"message":"Invalid token."}}.
 *
 * SECURITY: the token is a USER SECRET. It is passed per request, NEVER committed, NEVER written to a
 * repo .env, and never serialized into a saved circuit. The UI holds it in sessionStorage only.
 */
import type { FetchFn } from './tier2-mediated.js';
import type { HttpRequest, HttpResponse, HttpHandler } from './tier1-fake.js';

/** A V-pin client both tiers implement; the V-pin sync loop + UI depend only on this. */
export interface BlynkClient {
  /** Read virtual pin V{vpin}; returns the value string, or null on error/unset. */
  read(vpin: number): Promise<string | null>;
  /** Write virtual pin V{vpin}; returns true on success. */
  write(vpin: number, value: string): Promise<boolean>;
  /** Whether Blynk considers the (virtual) hardware connected for this token. */
  isHardwareConnected(): Promise<boolean>;
  /** The most recent error message (invalid token / CORS / network), or null. */
  readonly lastError: string | null;
}

/**
 * Tier 1 — a deterministic in-memory Blynk cloud. `write` stores a V-pin; `read` returns it. `inject`
 * simulates a dashboard widget writing a value (so a lesson can exercise "the app changed V0 → my relay
 * turned on" with no account). `connected` defaults true; set it to model an offline device.
 */
export class FakeBlynkClient implements BlynkClient {
  private readonly vpins = new Map<number, string>();
  lastError: string | null = null;
  constructor(private connected = true) {}

  read(vpin: number): Promise<string | null> {
    return Promise.resolve(this.vpins.get(vpin) ?? null);
  }
  write(vpin: number, value: string): Promise<boolean> {
    this.vpins.set(vpin, value);
    return Promise.resolve(true);
  }
  isHardwareConnected(): Promise<boolean> {
    return Promise.resolve(this.connected);
  }
  /** Test/lesson stimulus: a dashboard widget sets V{vpin} (read back by the sketch/sync loop). */
  inject(vpin: number, value: string): void {
    this.vpins.set(vpin, value);
  }
  /** Model the device going offline/online (drives isHardwareConnected). */
  setConnected(c: boolean): void {
    this.connected = c;
  }
}

export interface Tier2BlynkOpts {
  token: string;
  /** Blynk cloud host (default blynk.cloud). Regional hosts (ny3/sgp1/fra1.blynk.cloud) also work. */
  server?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchFn?: FetchFn;
}

/** Tier 2 — the real Blynk cloud over browser fetch. CORS-readable from the app origin (retest-confirmed). */
export class Tier2BlynkClient implements BlynkClient {
  private readonly token: string;
  private readonly server: string;
  private readonly fetchFn: FetchFn;
  lastError: string | null = null;

  constructor(opts: Tier2BlynkOpts) {
    this.token = opts.token;
    this.server = opts.server ?? 'blynk.cloud';
    const f = opts.fetchFn ?? (globalThis as { fetch?: FetchFn }).fetch;
    if (!f) throw new Error('Tier2BlynkClient: no fetch available (pass opts.fetchFn)');
    // Bind to globalThis — native fetch called as `this.fetchFn(...)` throws "Illegal invocation".
    this.fetchFn = f.bind(globalThis) as FetchFn;
  }

  private api(op: string, query: string): string {
    return `https://${this.server}/external/api/${op}?token=${encodeURIComponent(this.token)}&${query}`;
  }

  async read(vpin: number): Promise<string | null> {
    try {
      const r = await this.fetchFn(this.api('get', `V${vpin}`), { method: 'GET' });
      const text = (await r.text()).trim();
      if (r.status !== 200) {
        this.lastError = parseBlynkError(text, r.status);
        return null;
      }
      this.lastError = null;
      return parseBlynkValue(text);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'fetch failed';
      return null;
    }
  }

  async write(vpin: number, value: string): Promise<boolean> {
    try {
      const r = await this.fetchFn(this.api('update', `V${vpin}=${encodeURIComponent(value)}`), {
        method: 'GET',
      });
      if (r.status !== 200) {
        this.lastError = parseBlynkError((await r.text()).trim(), r.status);
        return false;
      }
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'fetch failed';
      return false;
    }
  }

  async isHardwareConnected(): Promise<boolean> {
    try {
      const r = await this.fetchFn(this.api('isHardwareConnected', ''), { method: 'GET' });
      const text = (await r.text()).trim();
      if (r.status !== 200) {
        this.lastError = parseBlynkError(text, r.status);
        return false;
      }
      this.lastError = null;
      return text === 'true';
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'fetch failed';
      return false;
    }
  }
}

/**
 * Tier-1 fake Blynk CLOUD (server side) — an in-memory virtual-pin store that answers the firmware's
 * Blynk Device-API requests offline + deterministically. Mount it on a Tier-1 FakeHttpServer:
 *   server.route('blynk.cloud', new FakeBlynkServer().handler())
 * Handles GET /external/api/update?…&V<n>=<val> (store), /external/api/get?…&V<n> (read → ["val"]),
 * and /external/api/isHardwareConnected (→ true). `inject` simulates a dashboard widget write so a
 * lesson/test can drive a BLYNK_WRITE handler without any account or egress.
 */
export class FakeBlynkServer {
  readonly vpins = new Map<number, string>();

  /** Simulate a Blynk dashboard widget writing V{vpin} (read back by the firmware's Blynk.run()). */
  inject(vpin: number, value: string): void {
    this.vpins.set(vpin, value);
  }

  private static vpinKey(query: string): number | null {
    for (const part of query.split('&')) {
      const m = /^V(\d+)/.exec(part);
      if (m) return Number(m[1]);
    }
    return null;
  }

  handler(): HttpHandler {
    return (req: HttpRequest): HttpResponse => {
      const query = req.path.split('?')[1] ?? '';
      if (req.path.includes('isHardwareConnected')) return { status: 200, body: 'true' };
      if (req.path.includes('/update')) {
        for (const part of query.split('&')) {
          const m = /^V(\d+)=(.*)$/.exec(part);
          if (m) this.vpins.set(Number(m[1]), decodeURIComponent(m[2] ?? ''));
        }
        return { status: 200, body: '1' };
      }
      if (req.path.includes('/get')) {
        const vp = FakeBlynkServer.vpinKey(query);
        const val = vp !== null ? (this.vpins.get(vp) ?? '') : '';
        return { status: 200, body: `["${val}"]` };
      }
      return { status: 404, body: '' };
    };
  }
}

/** Blynk get returns a JSON array (e.g. `["42"]`) or a bare value; normalise to a single string. */
export function parseBlynkValue(text: string): string {
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text) as unknown[];
      return arr.length ? String(arr[0]) : '';
    } catch {
      /* fall through to raw */
    }
  }
  return text;
}

/** Extract a human message from a Blynk error body (`{"error":{"message":"Invalid token."}}`). */
export function parseBlynkError(text: string, status: number): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } };
    if (j.error?.message) return j.error.message;
  } catch {
    /* not JSON */
  }
  return `Blynk HTTP ${status}`;
}
