import { describe, it, expect } from 'vitest';
import {
  FakeBlynkClient,
  Tier2BlynkClient,
  FakeBlynkServer,
  parseBlynkValue,
  parseBlynkError,
} from './blynk-client.js';
import type { FetchFn } from './tier2-mediated.js';
import type { HttpRequest } from './tier1-fake.js';

describe('FakeBlynkClient — deterministic V-pin loopback (Tier 1, offline)', () => {
  it('round-trips a written V-pin and reports connection', async () => {
    const c = new FakeBlynkClient();
    expect(await c.read(0)).toBeNull(); // unset
    expect(await c.write(0, '1')).toBe(true);
    expect(await c.read(0)).toBe('1');
    expect(await c.isHardwareConnected()).toBe(true);
  });

  it('inject() simulates a dashboard widget write; setConnected models an offline device', async () => {
    const c = new FakeBlynkClient();
    c.inject(3, '42');
    expect(await c.read(3)).toBe('42');
    c.setConnected(false);
    expect(await c.isHardwareConnected()).toBe(false);
  });
});

describe('Tier2BlynkClient — real Blynk cloud over an injected fetch', () => {
  /** A stub fetch recording calls + returning a scripted response. */
  function stub(status: number, body: string): { fetchFn: FetchFn; urls: string[] } {
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      urls.push(url);
      return { status, text: async () => body };
    };
    return { fetchFn, urls };
  }

  it('builds the get/update/isHardwareConnected URLs with the token + V-pin', async () => {
    const { fetchFn, urls } = stub(200, '1');
    const c = new Tier2BlynkClient({ token: 'TOK', fetchFn });
    await c.read(0);
    await c.write(5, '128');
    await c.isHardwareConnected();
    expect(urls[0]).toBe('https://blynk.cloud/external/api/get?token=TOK&V0');
    expect(urls[1]).toBe('https://blynk.cloud/external/api/update?token=TOK&V5=128');
    expect(urls[2]).toBe('https://blynk.cloud/external/api/isHardwareConnected?token=TOK&');
  });

  it('reads a value, treating a JSON-array body as the first element', async () => {
    const c = new Tier2BlynkClient({ token: 'T', fetchFn: stub(200, '["42"]').fetchFn });
    expect(await c.read(1)).toBe('42');
    expect(c.lastError).toBeNull();
  });

  it('surfaces an invalid-token 400 as a readable error (read → null, write → false)', async () => {
    const body = '{"error":{"message":"Invalid token."}}';
    const c = new Tier2BlynkClient({ token: 'BAD', fetchFn: stub(400, body).fetchFn });
    expect(await c.read(0)).toBeNull();
    expect(c.lastError).toBe('Invalid token.');
    expect(await c.write(0, '1')).toBe(false);
    expect(await c.isHardwareConnected()).toBe(false);
  });

  it('honours a regional server host', async () => {
    const { fetchFn, urls } = stub(200, 'true');
    const c = new Tier2BlynkClient({ token: 'T', server: 'sgp1.blynk.cloud', fetchFn });
    await c.isHardwareConnected();
    expect(urls[0]).toContain('https://sgp1.blynk.cloud/external/api/');
  });

  it('reports a network/CORS failure without throwing', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('Failed to fetch');
    };
    const c = new Tier2BlynkClient({ token: 'T', fetchFn });
    expect(await c.read(0)).toBeNull();
    expect(c.lastError).toBe('Failed to fetch');
  });
});

describe('FakeBlynkServer — Tier-1 fake Blynk cloud (the firmware-driven path)', () => {
  const req = (path: string): HttpRequest => ({
    method: 'GET',
    host: 'blynk.cloud',
    port: 443,
    path,
    body: '',
  });

  it('answers /update (store) and /get (read as a JSON array), like the real Device API', () => {
    const srv = new FakeBlynkServer();
    const h = srv.handler();
    expect(h(req('/external/api/update?token=T&V1=1234'))).toEqual({ status: 200, body: '1' });
    expect(srv.vpins.get(1)).toBe('1234'); // the firmware's virtualWrite landed
    expect(h(req('/external/api/get?token=T&V1'))).toEqual({ status: 200, body: '["1234"]' });
  });

  it('inject() simulates a dashboard write the firmware reads back; isHardwareConnected → true', () => {
    const srv = new FakeBlynkServer();
    const h = srv.handler();
    srv.inject(0, '1'); // the Blynk app turned a button on
    expect(h(req('/external/api/get?token=T&V0'))).toEqual({ status: 200, body: '["1"]' });
    expect(h(req('/external/api/isHardwareConnected?token=T'))).toEqual({
      status: 200,
      body: 'true',
    });
    expect(h(req('/external/api/get?token=T&V9'))).toEqual({ status: 200, body: '[""]' }); // unset → empty
  });
});

describe('blynk parse helpers', () => {
  it('parseBlynkValue handles arrays, bare values, and malformed JSON', () => {
    expect(parseBlynkValue('["7"]')).toBe('7');
    expect(parseBlynkValue('7')).toBe('7');
    expect(parseBlynkValue('[]')).toBe('');
    expect(parseBlynkValue('[bad')).toBe('[bad');
  });
  it('parseBlynkError extracts the Blynk message or falls back to the status', () => {
    expect(parseBlynkError('{"error":{"message":"Invalid token."}}', 400)).toBe('Invalid token.');
    expect(parseBlynkError('not json', 500)).toBe('Blynk HTTP 500');
  });
});
