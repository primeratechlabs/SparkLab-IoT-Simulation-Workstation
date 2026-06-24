/**
 * Unit coverage for the toolchain-asset integrity layer (AUD-013) — the pure, fetch-injectable core that the
 * real-*-toolchain loaders use. Proves: a correct asset passes, a single tampered byte is rejected BEFORE
 * use, an unpinned asset under an enforced manifest is rejected, and an absent manifest degrades (no-op).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sha256Hex,
  verifyAssetIntegrity,
  enforcePin,
  fetchIntegrityManifest,
  fetchVerifiedBytes,
  AssetIntegrityError,
} from './asset-integrity.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const mockFetch = (
  map: Record<string, { ok: boolean; body?: unknown; bin?: Uint8Array }>,
): typeof fetch =>
  ((url: string) => {
    const e = map[url];
    if (!e) return Promise.resolve({ ok: false, status: 404 } as Response);
    return Promise.resolve({
      ok: e.ok,
      status: e.ok ? 200 : 404,
      json: async () => e.body,
      arrayBuffer: async () => (e.bin ?? new Uint8Array()).buffer,
    } as Response);
  }) as unknown as typeof fetch;

describe('asset-integrity (AUD-013)', () => {
  it('sha256Hex is stable + matches a known vector', async () => {
    expect(await sha256Hex(bytes(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex(bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes only the view, not the whole backing buffer', async () => {
    const big = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = big.subarray(1, 4); // [2,3,4]
    expect(await sha256Hex(view)).toBe(await sha256Hex(new Uint8Array([2, 3, 4])));
  });

  it('verifyAssetIntegrity passes on match, throws on a single-byte tamper', async () => {
    const data = bytes('clang.wasm payload');
    const good = await sha256Hex(data);
    await expect(verifyAssetIntegrity(data, good, 'clang.mjs')).resolves.toBeUndefined();
    const tampered = bytes('clang.wasm payloaX'); // one byte changed
    await expect(verifyAssetIntegrity(tampered, good, 'clang.mjs')).rejects.toBeInstanceOf(
      AssetIntegrityError,
    );
  });

  it('enforcePin: verifies when pinned, REJECTS an unpinned asset under an enforced manifest, no-ops when absent', async () => {
    const data = bytes('lld');
    const pin = await sha256Hex(data);
    await expect(enforcePin(data, 'lld.mjs', { 'lld.mjs': pin })).resolves.toBe(data); // pinned + match
    await expect(enforcePin(data, 'lld.mjs', { 'other.mjs': pin })).rejects.toBeInstanceOf(
      AssetIntegrityError,
    ); // no pin for it
    await expect(enforcePin(data, 'lld.mjs', null)).resolves.toBe(data); // no manifest → degrade
  });

  it('fetchVerifiedBytes rejects a tampered asset BEFORE returning it', async () => {
    const real = bytes('the real clang module');
    const pin = await sha256Hex(real);
    const manifest = { 'clang.mjs': pin };
    const f = mockFetch({ '/tc/clang.mjs': { ok: true, bin: real } });
    await expect(fetchVerifiedBytes('/tc/clang.mjs', 'clang.mjs', manifest, f)).resolves.toEqual(
      real,
    );
    // server now serves a substituted module under the same URL:
    const evil = mockFetch({ '/tc/clang.mjs': { ok: true, bin: bytes('malicious module') } });
    await expect(
      fetchVerifiedBytes('/tc/clang.mjs', 'clang.mjs', manifest, evil),
    ).rejects.toBeInstanceOf(AssetIntegrityError);
  });

  it('fetchIntegrityManifest returns the map when present, null (with a warning) when absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const present = mockFetch({
      '/tc/integrity.json': { ok: true, body: { 'clang.mjs': 'deadbeef' } },
    });
    expect(await fetchIntegrityManifest('/tc', present)).toEqual({ 'clang.mjs': 'deadbeef' });
    expect(await fetchIntegrityManifest('/tc', mockFetch({}))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
