/**
 * Reproducible-build flags — REFERENCE-SPEC §11, invariant I4.
 *
 * Every compile MUST carry these so identical input → byte-identical object:
 *   - fixed __DATE__/__TIME__/__TIMESTAMP__ (kill wall-clock nondeterminism)
 *   - -ffile-prefix-map=<sandbox>=.  (strip absolute sandbox paths)
 *   - -frandom-seed=<source_hash>    (deterministic symbol mangling/seeds)
 * Link step pins build-id off; archives use `ar D` (deterministic mode).
 */

import { bareHash } from '@sparklab/shared';
import type { Sha256 } from '@sparklab/shared';

export const FIXED_DATE = 'Jan  1 2020';
export const FIXED_TIME = '00:00:00';
export const FIXED_TIMESTAMP = 'Wed Jan  1 00:00:00 2020';

export const DEFAULT_SANDBOX = '/work';

export function reproducibleCompileFlags(sourceHash: Sha256, sandbox = DEFAULT_SANDBOX): string[] {
  return [
    `-ffile-prefix-map=${sandbox}=.`,
    `-frandom-seed=${bareHash(sourceHash)}`,
    '-Wno-builtin-macro-redefined',
    `-D__DATE__="${FIXED_DATE}"`,
    `-D__TIME__="${FIXED_TIME}"`,
    `-D__TIMESTAMP__="${FIXED_TIMESTAMP}"`,
  ];
}

export function reproducibleLinkFlags(): string[] {
  return ['-Wl,--build-id=none'];
}

/** Deterministic archiver flags (GNU ar): D = no timestamps/uid/gid, deterministic. */
export const REPRODUCIBLE_AR_FLAGS = 'rcsD';

/**
 * Merge base flags with reproducible flags, de-duplicating while preserving order
 * (base flags first so callers can't accidentally override determinism flags).
 */
export function withReproducibleCompileFlags(
  baseFlags: string[],
  sourceHash: Sha256,
  sandbox = DEFAULT_SANDBOX,
): string[] {
  const repro = reproducibleCompileFlags(sourceHash, sandbox);
  const seen = new Set(baseFlags);
  return [...baseFlags, ...repro.filter((f) => !seen.has(f))];
}

/** True iff the mandatory determinism flags are all present. */
export function hasReproducibleFlags(flags: string[]): boolean {
  const joined = flags.join(' ');
  return (
    joined.includes('-ffile-prefix-map=') &&
    joined.includes('-frandom-seed=') &&
    joined.includes('-D__DATE__=')
  );
}
