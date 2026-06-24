/**
 * Toolchain loader: instantiates a WASM toolchain ONCE per variant and keeps it
 * warm (invariant I2 / Stage 1 gate "instantiate count = 1 for N compiles"). For
 * Stage 1 this loads the deterministic stub; the real loader will use
 * WebAssembly.compileStreaming on the OPFS-installed toolchain pack with the same
 * warm-singleton semantics.
 */

import type { Toolchain } from './types.js';
import { StubToolchain } from './stub-toolchain.js';

const warm = new Map<string, Toolchain>();

export type ToolchainKind = 'stub';

/** Load (or reuse the warm) toolchain for a variant. Repeated calls do NOT re-instantiate. */
export function loadToolchain(
  variant: 'threaded' | 'singlethread',
  kind: ToolchainKind = 'stub',
): Toolchain {
  const key = `${kind}:${variant}`;
  let tc = warm.get(key);
  if (!tc) {
    tc = createToolchain(kind, variant);
    warm.set(key, tc);
  }
  return tc;
}

function createToolchain(kind: ToolchainKind, variant: 'threaded' | 'singlethread'): Toolchain {
  switch (kind) {
    case 'stub':
      return new StubToolchain(variant);
    default:
      throw new Error(`unknown toolchain kind: ${kind}`);
  }
}

/** Total heavy-instantiation count across all stub toolchains (observability for the gate). */
export function toolchainInstantiations(): number {
  return StubToolchain.instantiations;
}

/** Test/e2e helper: drop warm instances and reset the counter. */
export function resetToolchains(): void {
  warm.clear();
  StubToolchain.resetInstantiations();
}
