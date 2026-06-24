/**
 * Build graph: turns scanned source units into per-unit compile plans, each with
 * its ObjectCacheKeyInput and the exact (reproducible) flags to compile with.
 * Content-hash everything so the scheduler can decide reuse vs recompile (§11).
 */

import type { ObjectCacheKeyInput, Sha256 } from '@sparklab/shared';
import { withReproducibleCompileFlags } from './reproducible.js';
import { getProfile, type OptimizationProfileId } from './optimization-profiles.js';
import type { UnitScan } from './dep-scanner.js';

export interface BuildUnitInput {
  id: string;
  sourceKey: Sha256;
  sourceBytes: Uint8Array;
  /** Compiler language — 'c' routes to cc1, otherwise cc1plus (C++). */
  language?: 'c' | 'c++';
}

export interface BuildUnitPlan {
  unitId: string;
  sourceKey: Sha256;
  sourceBytes: Uint8Array;
  target: string;
  language?: 'c' | 'c++';
  flags: string[]; // final flags incl. reproducible (used for both compile + key)
  includedHeaderHashes: Sha256[];
  keyInput: ObjectCacheKeyInput;
}

export interface PlanOptions {
  target: string; // target triple
  compilerId: string;
  sdkPackHash: Sha256;
  libraryPackHash: Sha256;
  baseFlags?: string[];
  profile?: OptimizationProfileId;
  sandbox?: string;
}

export function planBuildUnits(
  units: BuildUnitInput[],
  scans: UnitScan[],
  opts: PlanOptions,
): BuildUnitPlan[] {
  const scanById = new Map(scans.map((s) => [s.id, s]));
  const profile = getProfile(opts.profile);

  return units.map((unit) => {
    const scan = scanById.get(unit.id);
    const includedHeaderHashes = scan?.headerHashes ?? [];
    const base = [...profile.compileFlags, ...(opts.baseFlags ?? [])];
    const flags = withReproducibleCompileFlags(base, unit.sourceKey, opts.sandbox);

    const keyInput: ObjectCacheKeyInput = {
      compilerId: opts.compilerId,
      // Fold language into the key so a C and a C++ unit with identical bytes never
      // alias to the same cached object (they compile differently). Not passed to the
      // compiler — the toolchain derives -std/-x from the language field directly.
      compilerFlags: unit.language ? [`-x=${unit.language}`, ...flags] : flags,
      targetTriple: opts.target,
      sourceHash: unit.sourceKey,
      includedHeaderHashes,
      sdkPackHash: opts.sdkPackHash,
      libraryPackHash: opts.libraryPackHash,
    };

    return {
      unitId: unit.id,
      sourceKey: unit.sourceKey,
      sourceBytes: unit.sourceBytes,
      target: opts.target,
      ...(unit.language ? { language: unit.language } : {}),
      flags,
      includedHeaderHashes,
      keyInput,
    };
  });
}
