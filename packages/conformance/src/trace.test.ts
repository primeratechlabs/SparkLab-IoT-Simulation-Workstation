import { describe, it, expect } from 'vitest';
import { compareTraces, type Trace } from './trace.js';

const ref: Trace = [
  { tNs: 0, kind: 'gpio', key: '13=1' },
  { tNs: 1_000_000_000, kind: 'gpio', key: '13=0' },
  { tNs: 2_000_000_000, kind: 'gpio', key: '13=1' },
];

describe('compareTraces', () => {
  it('matches an identical trace', () => {
    const d = compareTraces(ref, ref);
    expect(d.ok).toBe(true);
    expect(d.matched).toBe(3);
  });

  it('accepts timing within tolerance', () => {
    const actual = ref.map((e) => ({ ...e, tNs: e.tNs + 500_000 })); // +0.5ms
    expect(compareTraces(ref, actual, { timeToleranceNs: 1_000_000 }).ok).toBe(true);
  });

  it('flags timing beyond tolerance', () => {
    const actual = ref.map((e, i) => (i === 1 ? { ...e, tNs: e.tNs + 5_000_000 } : e));
    const d = compareTraces(ref, actual, { timeToleranceNs: 1_000_000 });
    expect(d.ok).toBe(false);
    expect(d.mismatches[0]!.reason).toBe('timing');
  });

  it('flags a wrong key (e.g. pin value)', () => {
    const actual = [...ref];
    actual[1] = { ...actual[1]!, key: '13=1' };
    expect(compareTraces(ref, actual).mismatches[0]!.reason).toBe('key');
  });

  it('flags missing and extra events', () => {
    expect(compareTraces(ref, ref.slice(0, 2)).mismatches[0]!.reason).toBe('missing');
    expect(compareTraces(ref.slice(0, 2), ref).mismatches[0]!.reason).toBe('extra');
  });

  it('orderingOnly ignores absolute timing', () => {
    const actual = ref.map((e) => ({ ...e, tNs: e.tNs + 9_000_000_000 }));
    expect(compareTraces(ref, actual, { orderingOnly: true }).ok).toBe(true);
  });
});
