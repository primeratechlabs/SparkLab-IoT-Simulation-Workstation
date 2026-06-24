import { describe, it, expect } from 'vitest';
import { compareSemver, pickLatest, type InstalledPackRecord } from './index-db.js';

describe('compareSemver', () => {
  it('orders dotted versions numerically, not lexicographically', () => {
    // localeCompare/string sort puts 1.2.10 before 1.2.9 — this must not.
    expect(compareSemver('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareSemver('1.2.9', '1.2.10')).toBeLessThan(0);
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('treats missing trailing segments as 0', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('1.2.1', '1.2')).toBeGreaterThan(0);
  });

  it('returns 0 for equal versions', () => {
    expect(compareSemver('3.4.5', '3.4.5')).toBe(0);
  });

  it('falls back to string compare for non-numeric segments', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
  });
});

function pack(version: string): InstalledPackRecord {
  return {
    name: 'p',
    version,
    packType: 'sdk',
    manifestHash: version,
    sizeBytes: 1,
    installedAt: 0,
  };
}

describe('pickLatest', () => {
  it('selects the semantically-latest version regardless of input order', () => {
    expect(pickLatest([pack('1.2.9'), pack('1.2.10'), pack('1.2.2')])?.version).toBe('1.2.10');
    expect(pickLatest([pack('1.2.10'), pack('1.2.9')])?.version).toBe('1.2.10');
  });

  it('returns null for an empty list', () => {
    expect(pickLatest([])).toBeNull();
  });
});
