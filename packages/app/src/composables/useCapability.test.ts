import { describe, it, expect } from 'vitest';
import { planExecution } from '@sparklab/capability';
import type { CapabilityProfile } from '@sparklab/shared';
import { summarizeCapability } from './useCapability';

/** A capable (tier-S-ish) profile; override fields per case. */
function profile(over: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    tier: 'S',
    hardwareConcurrency: 8,
    deviceMemoryGB: 16,
    storageQuotaBytes: 10_000_000_000,
    storagePersisted: true,
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    atomics: true,
    opfs: true,
    fileSystemAccess: true,
    offscreenCanvas: true,
    webgpu: true,
    wasmSimd: true,
    wasmThreads: true,
    browser: { brand: 'Chrome', version: '120' },
    incognitoRisk: false,
    wasmInstantiateMsFor50MB: null,
    opfsWriteMBps: null,
    opfsReadMBps: null,
    ...over,
  };
}

const summarize = (p: CapabilityProfile) => summarizeCapability(p, planExecution(p));

describe('summarizeCapability — honest browser readiness (AUD-011)', () => {
  it('fully-capable browser: ready, threaded, no limitations', () => {
    const s = summarize(profile({ tier: 'S' }));
    expect(s.ready).toBe(true);
    expect(s.threaded).toBe(true);
    expect(s.limitations).toEqual([]);
    expect(s.headline).toMatch(/sẵn sàng mô phỏng đầy đủ/i);
  });

  it('no cross-origin isolation (tier B): still builds, but single-thread + a stated limitation', () => {
    const s = summarize(
      profile({ tier: 'B', crossOriginIsolated: false, sharedArrayBuffer: false, atomics: false }),
    );
    expect(s.ready).toBe(true); // tier B still client-compiles
    expect(s.threaded).toBe(false);
    expect(s.limitations.some((l) => /cross-origin isolation/i.test(l))).toBe(true);
    expect(s.headline).toMatch(/đơn luồng/i);
  });

  it('no OPFS (tier C): NOT fully ready — cached-firmware only, OPFS limitation stated', () => {
    const s = summarize(profile({ tier: 'C', opfs: false }));
    expect(s.ready).toBe(false);
    expect(s.buildMode).toBe('cached-firmware');
    expect(s.limitations.some((l) => /OPFS/i.test(l))).toBe(true);
    expect(s.headline).not.toMatch(/sẵn sàng mô phỏng đầy đủ/i);
  });

  it('unsupported browser (tier D): preview-only, not ready', () => {
    const s = summarize(
      profile({
        tier: 'D',
        opfs: false,
        crossOriginIsolated: false,
        sharedArrayBuffer: false,
        atomics: false,
        wasmSimd: false,
      }),
    );
    expect(s.ready).toBe(false);
    expect(s.buildMode).toBe('preview');
    expect(s.headline).toMatch(/xem trước/i);
  });

  it('flags a missing WASM SIMD even on an otherwise-ready browser', () => {
    const s = summarize(profile({ tier: 'A', wasmSimd: false }));
    expect(s.ready).toBe(true);
    expect(s.limitations.some((l) => /SIMD/i.test(l))).toBe(true);
  });
});
