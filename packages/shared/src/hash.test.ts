import { describe, it, expect } from 'vitest';
import { sha256, toHex, fromHex, bareHash } from './hash.js';

describe('hash', () => {
  it('computes a known SHA-256 vector', async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await sha256('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic for identical input (I4)', async () => {
    const a = await sha256('reproducible-input');
    const b = await sha256('reproducible-input');
    expect(a).toBe(b);
  });

  it('hex round-trips', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(toHex(bytes)).toBe('00010f10ff');
    expect(Array.from(fromHex('00010f10ff'))).toEqual([0, 1, 15, 16, 255]);
  });

  it('fromHex tolerates sha256: prefix', () => {
    expect(Array.from(fromHex('sha256:ff00'))).toEqual([255, 0]);
  });

  it('bareHash strips prefix and rejects others', () => {
    expect(bareHash('sha256:deadbeef')).toBe('deadbeef');
    expect(() => bareHash('md5:deadbeef')).toThrow();
  });
});
