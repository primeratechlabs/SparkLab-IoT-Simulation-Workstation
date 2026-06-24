import { describe, it, expect } from 'vitest';
import { planExecution } from './planner.js';
import type { CapabilityProfile } from '@sparklab/shared';

function profile(over: Partial<CapabilityProfile>): CapabilityProfile {
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
    webgpu: false,
    wasmSimd: true,
    wasmThreads: true,
    browser: { brand: 'Chromium', version: '130' },
    incognitoRisk: false,
    wasmInstantiateMsFor50MB: null,
    opfsWriteMBps: null,
    opfsReadMBps: null,
    ...over,
  };
}

describe('planExecution (skeleton)', () => {
  it('tier S → threaded native client compile', () => {
    const plan = planExecution(profile({ tier: 'S' }));
    expect(plan.toolchainVariant).toBe('threaded');
    expect(plan.buildMode).toBe('client-native-wasm-compile');
  });

  it('no COI → single-thread variant, never crashes (I9)', () => {
    const plan = planExecution(
      profile({ tier: 'B', crossOriginIsolated: false, sharedArrayBuffer: false, atomics: false }),
    );
    expect(plan.toolchainVariant).toBe('singlethread');
    expect(plan.buildMode).toBe('client-native-wasm-compile');
  });

  it('tier D → preview only', () => {
    expect(planExecution(profile({ tier: 'D' })).buildMode).toBe('preview');
  });

  it('never selects backend-fallback by default (I8)', () => {
    for (const tier of ['S', 'A', 'B', 'C', 'D'] as const) {
      expect(planExecution(profile({ tier })).buildMode).not.toBe('backend-fallback');
    }
  });

  it('annotates board architecture in emulator profile', () => {
    const plan = planExecution(profile({ tier: 'A' }), {
      boardId: 'uno',
      architecture: 'avr',
    });
    expect(plan.emulatorProfile).toBe('avr-default');
  });
});
