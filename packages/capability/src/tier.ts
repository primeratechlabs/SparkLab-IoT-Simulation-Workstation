/**
 * Capability tier classifier — REFERENCE-SPEC §15.
 *
 * The tier drives the *execution plan* (not just a warning): which build mode,
 * threaded vs single-thread toolchain, how much simulation fidelity to attempt
 * (invariant I9 — graceful degradation by capability).
 *
 *   S: 16GB RAM, 8+ cores, OPFS quota >5GB, SAB        → full client build, C3, Xtensa try, appliance try
 *   A: 8GB RAM, 4–8 cores, OPFS quota >2GB, SAB        → Uno, C3, some ESP32 profiles
 *   B: OPFS present but no SAB/COI (or threaded-but-weak) → single-thread toolchain, reduced sim
 *   C: low storage / no OPFS                            → preview + small firmware
 *   D: browser unsupported                              → preview-only
 *
 * Pure & deterministic so it is unit-testable in Node without a browser.
 */

import type { CapabilityProfile, CapabilityTier } from '@sparklab/shared';

/** Fields needed to classify; a subset of CapabilityProfile (benchmarks not required). */
export type TierInput = Pick<
  CapabilityProfile,
  | 'crossOriginIsolated'
  | 'sharedArrayBuffer'
  | 'atomics'
  | 'opfs'
  | 'fileSystemAccess'
  | 'wasmSimd'
  | 'hardwareConcurrency'
  | 'deviceMemoryGB'
  | 'storageQuotaBytes'
>;

const GB = 1_000_000_000;

export function classifyTier(p: TierInput): CapabilityTier {
  const threaded = p.crossOriginIsolated && p.sharedArrayBuffer && p.atomics;
  const ramKnown = p.deviceMemoryGB != null;
  const ram = p.deviceMemoryGB ?? 0;
  const cores = p.hardwareConcurrency || 1;
  const quotaGB = (p.storageQuotaBytes ?? 0) / GB;

  // No persistent OPFS disk → cannot host packs/build cache as designed.
  if (!p.opfs) {
    // Truly minimal environment with no threading, no FS Access, no SIMD → preview-only.
    if (!threaded && !p.fileSystemAccess && !p.wasmSimd) return 'D';
    return 'C';
  }

  // OPFS present but no cross-origin-isolated threading → single-thread path.
  if (!threaded) return 'B';

  // Threaded + OPFS: rank by RAM / cores / quota.
  if (ramKnown && ram >= 16 && cores >= 8 && quotaGB > 5) return 'S';
  if (cores >= 4 && quotaGB > 2 && (!ramKnown || ram >= 8)) return 'A';

  // Threaded but below A thresholds → degrade to B (reduced sim, conservative builds).
  return 'B';
}
