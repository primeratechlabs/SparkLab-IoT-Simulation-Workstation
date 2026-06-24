import { describe, it, expect } from 'vitest';
import { resolveLibraryClosure, architectureMatches } from './library-resolver';
import type { UserLibrary } from './arduino-library';

/** Minimal UserLibrary builder for resolver tests (headers/sources/version irrelevant here). */
function lib(
  name: string,
  opts: { depends?: string[]; architectures?: string[] } = {},
): UserLibrary {
  return {
    name,
    version: '1.0.0',
    provides: [`${name}.h`],
    headers: [{ rel: `${name}.h`, content: '' }],
    sources: [{ rel: `${name}.cpp`, content: '', language: 'c++' }],
    architectures: opts.architectures ?? ['*'],
    depends: opts.depends ?? [],
  };
}

describe('library-resolver — dependency closure (AUD-018)', () => {
  it('pulls a transitive dependency that the sketch does not directly include', () => {
    const a = lib('A', { depends: ['B'] });
    const b = lib('B', { depends: ['C'] });
    const c = lib('C');
    const r = resolveLibraryClosure([a], [a, b, c], 'riscv32');
    expect(r.closure.map((l) => l.name)).toEqual(['C', 'B', 'A']); // post-order: dependency before dependent
    expect(r.missing).toEqual([]);
    expect(r.cycles).toEqual([]);
  });

  it('reports a missing dependency (no matching installed library)', () => {
    // depends names are lowercased by the parser, so the resolver reports them lowercased
    const a = lib('A', { depends: ['notinstalled'] });
    const r = resolveLibraryClosure([a], [a], 'riscv32');
    expect(r.closure.map((l) => l.name)).toEqual(['A']);
    expect(r.missing).toEqual(['notinstalled']);
  });

  it('terminates and reports a dependency cycle (A↔B), each library compiled once', () => {
    const a = lib('A', { depends: ['B'] });
    const b = lib('B', { depends: ['A'] });
    const r = resolveLibraryClosure([a], [a, b], 'xtensa');
    expect(r.closure.map((l) => l.name).sort()).toEqual(['A', 'B']); // each exactly once
    expect(r.cycles.length).toBeGreaterThan(0);
  });

  it('resolves dependency names case-insensitively', () => {
    const a = lib('A', { depends: ['mylib'] });
    const dep = lib('MyLib');
    const r = resolveLibraryClosure([a], [a, dep], 'avr');
    expect(r.closure.map((l) => l.name)).toContain('MyLib');
    expect(r.missing).toEqual([]);
  });

  it('does not duplicate a diamond dependency (A→B, A→C, B→D, C→D)', () => {
    const d = lib('D');
    const b = lib('B', { depends: ['D'] });
    const c = lib('C', { depends: ['D'] });
    const a = lib('A', { depends: ['B', 'C'] });
    const r = resolveLibraryClosure([a], [a, b, c, d], 'riscv32');
    expect(r.closure.filter((l) => l.name === 'D')).toHaveLength(1);
    expect(r.closure[0]!.name).toBe('D'); // the shared leaf comes first
  });
});

describe('library-resolver — architecture compatibility (AUD-018)', () => {
  it('a `*` (or absent) architecture matches every board', () => {
    expect(architectureMatches(lib('X', { architectures: ['*'] }), 'avr')).toBe(true);
    expect(architectureMatches(lib('X', { architectures: ['*'] }), 'riscv32')).toBe(true);
    expect(architectureMatches(lib('X', { architectures: ['*'] }), 'xtensa')).toBe(true);
  });

  it('maps esp32 to BOTH ESP32-C3 (riscv32) and ESP32-classic (xtensa)', () => {
    const esp = lib('Net', { architectures: ['esp32'] });
    expect(architectureMatches(esp, 'riscv32')).toBe(true);
    expect(architectureMatches(esp, 'xtensa')).toBe(true);
    expect(architectureMatches(esp, 'avr')).toBe(false);
  });

  it('flags an avr-only library as incompatible with an esp32 board (reported, not silently dropped)', () => {
    const avrOnly = lib('AvrThing', { architectures: ['avr'] });
    const ok = lib('Portable', { architectures: ['*'] });
    const r = resolveLibraryClosure([avrOnly, ok], [avrOnly, ok], 'riscv32');
    expect(r.incompatible.map((i) => i.name)).toEqual(['AvrThing']);
    expect(r.closure.map((l) => l.name)).toContain('AvrThing'); // still attempted — compiler is the truth
  });
});
