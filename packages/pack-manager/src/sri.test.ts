import { describe, it, expect } from 'vitest';
import { computeSri, verifySri, verifyAssets } from './sri.js';

const enc = new TextEncoder();

describe('SRI (Stage 7 supply chain)', () => {
  it('computeSri is deterministic and algorithm-prefixed', async () => {
    const a = await computeSri(enc.encode('hello'), 'sha384');
    const b = await computeSri(enc.encode('hello'), 'sha384');
    expect(a).toBe(b);
    expect(a).toMatch(/^sha384-/);
    expect(await computeSri(enc.encode('hello'), 'sha256')).toMatch(/^sha256-/);
    expect(await computeSri(enc.encode('hello'), 'sha512')).toMatch(/^sha512-/);
  });

  it('verifySri accepts matching bytes and rejects a single-byte change', async () => {
    const integ = await computeSri(enc.encode('firmware-bytes'));
    expect(await verifySri(enc.encode('firmware-bytes'), integ)).toBe(true);
    expect(await verifySri(enc.encode('firmware-byteX'), integ)).toBe(false);
  });

  it('fails closed on a malformed or unknown algorithm', async () => {
    expect(await verifySri(enc.encode('x'), 'md5-abc')).toBe(false);
    expect(await verifySri(enc.encode('x'), 'nonsense')).toBe(false);
    expect(await verifySri(enc.encode('x'), '')).toBe(false);
  });

  it('verifyAssets reports exactly the failing paths', async () => {
    const f1 = enc.encode('asset-1');
    const f2 = enc.encode('asset-2');
    const map = { 'a.js': await computeSri(f1), 'b.wasm': await computeSri(f2) };
    expect(
      await verifyAssets(
        [
          { path: 'a.js', bytes: f1 },
          { path: 'b.wasm', bytes: f2 },
        ],
        map,
      ),
    ).toEqual([]);
    // a tampered asset + an asset with no pinned integrity both fail
    expect(
      await verifyAssets(
        [
          { path: 'a.js', bytes: f1 },
          { path: 'b.wasm', bytes: enc.encode('TAMPERED') },
          { path: 'c.js', bytes: f1 },
        ],
        map,
      ),
    ).toEqual(['b.wasm', 'c.js']);
  });
});
