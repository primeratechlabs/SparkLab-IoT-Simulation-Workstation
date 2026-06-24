import { describe, it, expect } from 'vitest';
import { Tier2Network, isPrivateHost, type FetchFn } from './tier2-mediated.js';
import { WL_CONNECTED, type HttpRequest } from './tier1-fake.js';

const REQ: HttpRequest = {
  method: 'POST',
  host: 'api.example.com',
  port: 80,
  path: '/ingest',
  body: 'VAL=42',
};

function connect(net: Tier2Network): void {
  net.wifi.begin('sparklab');
  for (let i = 0; i < 5; i++) net.wifi.poll();
  expect(net.wifi.status()).toBe(WL_CONNECTED);
}

describe('network-shim tier 2 — Tier2Network (real fetch, mocked here)', () => {
  it('builds the URL (https for 443) and calls fetch with method + body', async () => {
    const seen: { url: string; init?: { method?: string; body?: string } }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, text: async () => 'OK 84' };
    };
    const net = new Tier2Network({ fetchFn, connectPolls: 1 });
    connect(net);

    const res = await net.fetch(REQ);
    expect(res).toEqual({ status: 200, body: 'OK 84' });
    expect(seen[0]!.url).toBe('http://api.example.com/ingest');
    expect(seen[0]!.init?.method).toBe('POST');
    expect(seen[0]!.init?.body).toBe('VAL=42');
    expect(net.calls).toHaveLength(1);

    expect(net.url({ ...REQ, port: 443, path: '/secure' })).toBe('https://api.example.com/secure');
    expect(net.url({ ...REQ, port: 8080 })).toBe('http://api.example.com:8080/ingest');
  });

  it('returns status 0 before WiFi is connected (no fetch issued)', async () => {
    let called = 0;
    const net = new Tier2Network({
      fetchFn: async () => {
        called++;
        return { status: 200, text: async () => '' };
      },
      connectPolls: 3,
    });
    const res = await net.fetch(REQ);
    expect(res).toEqual({ status: 0, body: '' });
    expect(called).toBe(0);
  });

  it('treats a fetch rejection (network error / CORS) as no connection (status 0)', async () => {
    const net = new Tier2Network({
      fetchFn: async () => {
        throw new Error('CORS');
      },
      connectPolls: 1,
    });
    connect(net);
    const res = await net.fetch(REQ);
    expect(res).toEqual({ status: 0, body: '' });
  });

  it('invokes fetch with the global `this` (regression: native fetch throws "Illegal invocation" otherwise)', async () => {
    // A native-like fetch that rejects a wrong `this` exactly as the browser/Worker does. Tier2Network
    // must bind it to globalThis; a method-style call (this = the instance) would throw.
    function strictFetch(
      this: unknown,
      url: string,
    ): Promise<{ status: number; text(): Promise<string> }> {
      if (this !== globalThis) throw new TypeError("Failed to execute 'fetch': Illegal invocation");
      return Promise.resolve({ status: 200, text: async () => `ok ${url}` });
    }
    const net = new Tier2Network({ fetchFn: strictFetch as FetchFn, connectPolls: 1 });
    connect(net);
    const res = await net.fetch(REQ);
    expect(res.status).toBe(200); // did NOT throw Illegal invocation
    expect(net.lastError).toBeNull();
  });

  it('blocks an SSRF target (localhost / private IP) on the real tier (AUD-025)', async () => {
    let called = 0;
    const net = new Tier2Network({
      fetchFn: async () => {
        called++;
        return { status: 200, text: async () => 'ok' };
      },
      connectPolls: 1,
    });
    connect(net);
    const res = await net.fetch({ ...REQ, host: '192.168.1.1', port: 80 });
    expect(res).toEqual({ status: 0, body: '' });
    expect(called).toBe(0); // the fetch was NEVER issued
    expect(net.lastError).toMatch(/nội bộ|riêng tư/);
    expect(
      isPrivateHost('127.0.0.1') &&
        isPrivateHost('localhost') &&
        isPrivateHost('10.0.0.5') &&
        isPrivateHost('172.16.9.9'),
    ).toBe(true);
    expect(
      isPrivateHost('api.example.com') ||
        isPrivateHost('blynk.cloud') ||
        isPrivateHost('iot.local'),
    ).toBe(false);
  });

  it('throws if constructed without a fetch and none is global', () => {
    const saved = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      expect(() => new Tier2Network()).toThrow(/no fetch/);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = saved;
    }
  });
});
