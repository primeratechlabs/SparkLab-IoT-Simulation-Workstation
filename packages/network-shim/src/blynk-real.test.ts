/**
 * Credential-gated REAL Blynk cloud test. Exercises Tier2BlynkClient against blynk.cloud over the
 * runtime's global fetch — the same CORS-readable Device HTTPS API the browser app uses. It SKIPS unless
 * a BLYNK_TOKEN is provided in the environment, so it never runs (and never needs a secret) in normal CI.
 *
 * To run it against your own throwaway device token (NEVER commit a token):
 *   BLYNK_TOKEN=xxxxxxxx pnpm vitest run packages/network-shim/src/blynk-real.test.ts
 * Optionally BLYNK_SERVER=fra1.blynk.cloud (regional) and BLYNK_VPIN=4 (a writable virtual pin).
 *
 * What it proves end-to-end: a valid token authenticates (no "Invalid token." error), a V-pin write
 * succeeds, and the value reads back — i.e. the real-tier path the curriculum Blynk lessons depend on.
 */
import { describe, it, expect } from 'vitest';
import { Tier2BlynkClient } from './blynk-client.js';

const TOKEN = process.env.BLYNK_TOKEN;
const SERVER = process.env.BLYNK_SERVER; // optional regional host
const VPIN = Number(process.env.BLYNK_VPIN ?? '50'); // a virtual pin safe to write in a test datastream

describe.skipIf(!TOKEN)('Tier2BlynkClient — REAL Blynk cloud (credential-gated)', () => {
  it('authenticates a valid token (isHardwareConnected returns a boolean, no error)', async () => {
    const c = new Tier2BlynkClient({ token: TOKEN!, server: SERVER });
    const connected = await c.isHardwareConnected();
    expect(typeof connected).toBe('boolean');
    expect(c.lastError).toBeNull(); // a valid token never yields "Invalid token."
  });

  it('writes a V-pin and reads the value back from the cloud', async () => {
    const c = new Tier2BlynkClient({ token: TOKEN!, server: SERVER });
    const value = String(Math.floor((Date.now() / 1000) % 1000)); // a changing, deterministic-enough value
    expect(await c.write(VPIN, value)).toBe(true);
    expect(c.lastError).toBeNull();
    const got = await c.read(VPIN);
    expect(c.lastError).toBeNull();
    expect(got).toBe(value); // the datastream round-tripped
  });
});

/**
 * Real-cloud NEGATIVE control — needs no secret, only network reachability (skips offline). Proves the
 * Tier2BlynkClient real path end-to-end against the LIVE Blynk API: a bogus token yields HTTP 400
 * {"error":{"message":"Invalid token."}}, which the client surfaces as a readable error.
 */
describe('Tier2BlynkClient — real Blynk cloud reachability (no token, skips offline)', () => {
  it('parses the live invalid-token 400 into a readable error', async (ctx) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      await fetch('https://blynk.cloud/external/api/isHardwareConnected?token=preflight', {
        signal: ctrl.signal,
      });
    } catch {
      ctx.skip(); // offline / blocked — not a product failure
      return;
    } finally {
      clearTimeout(t);
    }
    const c = new Tier2BlynkClient({ token: 'definitely-not-a-real-token' });
    expect(await c.read(0)).toBeNull();
    expect(c.lastError).toBe('Invalid token.'); // the exact message the live API returns
  }, 30000);
});
