import { describe, it, expect } from 'vitest';
import { selectLruEvictions, type LruEntry } from './quota.js';

const entries: LruEntry[] = [
  { key: 'a', sizeBytes: 100, lastUsedAt: 30 },
  { key: 'b', sizeBytes: 200, lastUsedAt: 10 },
  { key: 'c', sizeBytes: 50, lastUsedAt: 20 },
];

describe('selectLruEvictions', () => {
  it('evicts oldest-first until enough is freed', () => {
    // oldest order: b(10), c(20), a(30). Need 210 bytes → b(200)+c(50)=250.
    expect(selectLruEvictions(entries, 210)).toEqual(['b', 'c']);
  });

  it('returns nothing when no bytes need freeing', () => {
    expect(selectLruEvictions(entries, 0)).toEqual([]);
    expect(selectLruEvictions(entries, -5)).toEqual([]);
  });

  it('evicts everything when target exceeds total', () => {
    expect(selectLruEvictions(entries, 9999)).toEqual(['b', 'c', 'a']);
  });
});
