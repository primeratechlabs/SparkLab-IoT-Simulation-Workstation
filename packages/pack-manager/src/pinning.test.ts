import { describe, it, expect } from 'vitest';
import { manifestPinSet, isManifestPinned, assertManifestPinned } from './pinning.js';

describe('manifest pinning (Stage 7 supply chain)', () => {
  const pins = manifestPinSet('1.0.0', ['sha256:aaa', 'sha256:bbb']);

  it('accepts a pinned manifest hash', () => {
    expect(isManifestPinned('sha256:aaa', pins)).toBe(true);
    expect(() => assertManifestPinned('sha256:bbb', pins)).not.toThrow();
  });

  it('rejects a validly-signed but UNexpected (unpinned) manifest', () => {
    expect(isManifestPinned('sha256:ccc', pins)).toBe(false);
    expect(() => assertManifestPinned('sha256:ccc', pins)).toThrow(/not pinned for app 1\.0\.0/);
  });

  it('an empty pin set pins nothing (every manifest is rejected)', () => {
    const empty = manifestPinSet('1.0.0', []);
    expect(isManifestPinned('sha256:aaa', empty)).toBe(false);
    expect(() => assertManifestPinned('sha256:aaa', empty)).toThrow();
  });
});
