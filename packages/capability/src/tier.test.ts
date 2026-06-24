import { describe, it, expect } from 'vitest';
import { classifyTier, type TierInput } from './tier.js';

const base: TierInput = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  atomics: true,
  opfs: true,
  fileSystemAccess: true,
  wasmSimd: true,
  hardwareConcurrency: 8,
  deviceMemoryGB: 16,
  storageQuotaBytes: 10_000_000_000,
};

describe('classifyTier (§15)', () => {
  it('S: 16GB / 8 cores / >5GB quota / SAB', () => {
    expect(classifyTier(base)).toBe('S');
  });

  it('A: 8GB / 4 cores / >2GB quota / SAB', () => {
    expect(
      classifyTier({
        ...base,
        deviceMemoryGB: 8,
        hardwareConcurrency: 4,
        storageQuotaBytes: 3_000_000_000,
      }),
    ).toBe('A');
  });

  it('B: OPFS present but no SAB/COI → single-thread', () => {
    expect(classifyTier({ ...base, crossOriginIsolated: false, sharedArrayBuffer: false })).toBe(
      'B',
    );
  });

  it('B: threaded but weak (low cores/quota) degrades from A', () => {
    expect(
      classifyTier({ ...base, hardwareConcurrency: 2, storageQuotaBytes: 1_000_000_000 }),
    ).toBe('B');
  });

  it('C: no OPFS but otherwise capable', () => {
    expect(classifyTier({ ...base, opfs: false })).toBe('C');
  });

  it('D: no OPFS, no threading, no FS access, no SIMD', () => {
    expect(
      classifyTier({
        ...base,
        opfs: false,
        crossOriginIsolated: false,
        sharedArrayBuffer: false,
        atomics: false,
        fileSystemAccess: false,
        wasmSimd: false,
      }),
    ).toBe('D');
  });

  it('always returns a valid tier for unknown deviceMemory (Safari/Firefox)', () => {
    const tier = classifyTier({ ...base, deviceMemoryGB: null });
    expect(['S', 'A', 'B', 'C', 'D']).toContain(tier);
    // Cannot claim S without known RAM.
    expect(tier).toBe('A');
  });
});
