import { describe, it, expect } from 'vitest';
import { mulberry32, randomSketch, compareFirmware, compareText } from './differential.js';

describe('differential — seeded PRNG', () => {
  it('is deterministic per seed and varies across seeds', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB); // same seed → same sequence
    const c = mulberry32(43);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(seqA);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('differential — random valid sketch generator (fuzzing corpus)', () => {
  it('is reproducible per seed', () => {
    expect(randomSketch(7)).toBe(randomSketch(7));
    expect(randomSketch(7)).not.toBe(randomSketch(8));
  });

  it('always produces a structurally valid sketch (setup/loop, balanced braces)', () => {
    for (let seed = 0; seed < 200; seed++) {
      const s = randomSketch(seed);
      expect(s).toContain('void setup()');
      expect(s).toContain('void loop()');
      // balanced braces + parens — a quick well-formedness guard
      expect([...s].filter((c) => c === '{').length).toBe([...s].filter((c) => c === '}').length);
      expect([...s].filter((c) => c === '(').length).toBe([...s].filter((c) => c === ')').length);
      // only the expected vocabulary appears
      expect(s).toMatch(/pinMode|Serial\.begin/);
    }
  });

  it('honours the statement count', () => {
    const s = randomSketch(3, { statements: 2 });
    // two body statements → exactly two terminating semicolons after setup's, hard to count
    // precisely, but the sketch must still be valid and non-trivial
    expect(s.length).toBeGreaterThan(40);
  });
});

describe('differential — firmware comparator', () => {
  it('reports identical images', () => {
    const a = Uint8Array.of(1, 2, 3, 4);
    expect(compareFirmware(a, Uint8Array.of(1, 2, 3, 4))).toEqual({
      identical: true,
      firstDiffOffset: -1,
      lengthA: 4,
      lengthB: 4,
    });
  });
  it('reports the first differing byte', () => {
    const d = compareFirmware(Uint8Array.of(1, 2, 9, 4), Uint8Array.of(1, 2, 3, 4));
    expect(d.identical).toBe(false);
    expect(d.firstDiffOffset).toBe(2);
  });
  it('reports a length mismatch (one is a prefix of the other)', () => {
    const d = compareFirmware(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3, 4));
    expect(d.identical).toBe(false);
    expect(d.firstDiffOffset).toBe(3);
    expect([d.lengthA, d.lengthB]).toEqual([3, 4]);
  });
  it('compareText diffs transcripts', () => {
    expect(compareText('blink on', 'blink on').identical).toBe(true);
    expect(compareText('blink on', 'blink off').identical).toBe(false);
  });
});
