import { describe, it, expect } from 'vitest';
import {
  reproducibleCompileFlags,
  withReproducibleCompileFlags,
  hasReproducibleFlags,
} from './reproducible.js';

describe('reproducible flags (§11/I4)', () => {
  it('includes file-prefix-map, random-seed and fixed date macros', () => {
    const flags = reproducibleCompileFlags('sha256:abcd');
    expect(flags.some((f) => f.startsWith('-ffile-prefix-map='))).toBe(true);
    expect(flags).toContain('-frandom-seed=abcd');
    expect(flags.some((f) => f.startsWith('-D__DATE__='))).toBe(true);
  });

  it('is deterministic for the same source hash', () => {
    expect(reproducibleCompileFlags('sha256:x')).toEqual(reproducibleCompileFlags('sha256:x'));
  });

  it('merges without duplicating and keeps base flags first', () => {
    const merged = withReproducibleCompileFlags(['-O0', '-DSIM=1'], 'sha256:x');
    expect(merged.slice(0, 2)).toEqual(['-O0', '-DSIM=1']);
    expect(new Set(merged).size).toBe(merged.length);
    expect(hasReproducibleFlags(merged)).toBe(true);
  });

  it('detects missing reproducible flags', () => {
    expect(hasReproducibleFlags(['-O0'])).toBe(false);
  });
});
