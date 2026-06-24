/**
 * Optimization profiles — REFERENCE-SPEC §38. Default is "simulation": fast
 * compile, no LTO/debug, sim shims — because the product is simulation-first.
 */

export type OptimizationProfileId = 'simulation' | 'hardware' | 'high-fidelity';

export interface OptimizationProfile {
  id: OptimizationProfileId;
  /** Base compiler flags contributed by the profile (before reproducible flags). */
  compileFlags: string[];
  /** Whether link-time optimization is enabled. */
  lto: boolean;
  description: string;
}

export const OPTIMIZATION_PROFILES: Record<OptimizationProfileId, OptimizationProfile> = {
  simulation: {
    id: 'simulation',
    compileFlags: ['-O0', '-g0', '-DSPARKLAB_SIM=1'],
    lto: false,
    description: 'Fast compile, no LTO/debug, simulation shims. Default.',
  },
  hardware: {
    id: 'hardware',
    compileFlags: ['-Os'],
    lto: false,
    description: 'Board-default size optimization, closest to real firmware.',
  },
  'high-fidelity': {
    id: 'high-fidelity',
    compileFlags: ['-Os', '-g'],
    lto: true,
    description: 'Highest fidelity (LTO + debug info); slower, for non-live analysis.',
  },
};

export const DEFAULT_PROFILE: OptimizationProfileId = 'simulation';

export function getProfile(id: OptimizationProfileId = DEFAULT_PROFILE): OptimizationProfile {
  return OPTIMIZATION_PROFILES[id];
}
