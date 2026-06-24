/**
 * Capability profiler — REFERENCE-SPEC §15, Stage 0.
 *
 * Collects a CapabilityProfile from the running browser/worker. Every probe is
 * feature-detected and degrades to a safe default (never throws), so a weak or
 * non-isolated environment still yields a valid profile (invariant I9).
 *
 * Benchmark fields (wasmInstantiateMsFor50MB, opfs r/w MBps) are optional and
 * filled by ./benchmark when run in a worker; here they default to null.
 */

import type { CapabilityProfile } from '@sparklab/shared';
import { classifyTier } from './tier.js';
import { detectWasm, detectWasmSimd, detectWasmThreads } from './wasm-detect.js';

interface UADataLike {
  brands?: Array<{ brand: string; version: string }>;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    fullVersionList?: Array<{ brand: string; version: string }>;
    uaFullVersion?: string;
  }>;
}

function pickBrand(brands?: Array<{ brand: string; version: string }>): {
  brand: string;
  version: string;
} {
  if (!brands || brands.length === 0) return { brand: 'unknown', version: '0' };
  // Filter out the GREASE "Not;A=Brand" entries.
  const real = brands.find((b) => !/not.?a.?brand/i.test(b.brand)) ?? brands[0]!;
  return { brand: real.brand, version: real.version };
}

async function detectBrowser(): Promise<{ brand: string; version: string }> {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: UADataLike }) | undefined;
  const uaData = nav?.userAgentData;
  if (uaData) {
    const base = pickBrand(uaData.brands);
    try {
      const hi = await uaData.getHighEntropyValues?.(['fullVersionList', 'uaFullVersion']);
      const full = pickBrand(hi?.fullVersionList);
      if (full.brand !== 'unknown') return full;
      if (hi?.uaFullVersion) return { brand: base.brand, version: hi.uaFullVersion };
    } catch {
      /* fall through to base */
    }
    return base;
  }
  // Fallback: crude UA string parse (Firefox/Safari).
  const ua = nav?.userAgent ?? '';
  const m = ua.match(/(Firefox|Safari|Chrome|Edg)\/([\d.]+)/);
  return m ? { brand: m[1]!, version: m[2]! } : { brand: 'unknown', version: '0' };
}

function detectOpfs(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

function detectFileSystemAccess(): boolean {
  return typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function';
}

async function storageInfo(): Promise<{ quota: number | null; persisted: boolean }> {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { quota: null, persisted: false };
  }
  let quota: number | null = null;
  let persisted = false;
  try {
    const est = await navigator.storage.estimate();
    quota = typeof est.quota === 'number' ? est.quota : null;
  } catch {
    /* ignore */
  }
  try {
    persisted = (await navigator.storage.persisted?.()) ?? false;
  } catch {
    /* ignore */
  }
  return { quota, persisted };
}

export interface BenchmarkResults {
  wasmInstantiateMsFor50MB: number | null;
  opfsWriteMBps: number | null;
  opfsReadMBps: number | null;
}

export interface ProfilerOptions {
  /** Pre-computed benchmark results (from a worker run). */
  benchmarks?: BenchmarkResults;
}

export async function collectCapabilityProfile(
  options: ProfilerOptions = {},
): Promise<CapabilityProfile> {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;

  const { quota, persisted } = await storageInfo();
  const browser = await detectBrowser();

  const deviceMemoryGB = typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null;
  const hardwareConcurrency = nav?.hardwareConcurrency ?? 1;

  // Incognito heuristic: very small quota relative to typical persistent storage.
  const incognitoRisk = quota != null && quota < 300_000_000;

  const base = {
    hardwareConcurrency,
    deviceMemoryGB,
    storageQuotaBytes: quota,
    storagePersisted: persisted,
    crossOriginIsolated:
      typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    atomics: typeof Atomics !== 'undefined',
    opfs: detectOpfs(),
    fileSystemAccess: detectFileSystemAccess(),
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    wasmSimd: detectWasmSimd(),
    wasmThreads: detectWasmThreads(),
    browser,
    incognitoRisk,
    wasmInstantiateMsFor50MB: options.benchmarks?.wasmInstantiateMsFor50MB ?? null,
    opfsWriteMBps: options.benchmarks?.opfsWriteMBps ?? null,
    opfsReadMBps: options.benchmarks?.opfsReadMBps ?? null,
  };

  // detectWasm() is implied by the platform; surface it via a guard so a wasm-less
  // environment still classifies (tier D path).
  void detectWasm();

  const tier = classifyTier(base);
  return { tier, ...base };
}
