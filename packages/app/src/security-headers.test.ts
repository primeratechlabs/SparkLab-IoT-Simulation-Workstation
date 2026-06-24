import { describe, expect, it } from 'vitest';
import { coiHeaders, cspHeader } from '../vite.config.js';

describe('production security headers', () => {
  it('keeps cross-origin isolation enabled', () => {
    expect(coiHeaders).toMatchObject({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  });

  it('allows only the blob module capability required by the client toolchain', () => {
    const csp = cspHeader['Content-Security-Policy'];
    expect(csp).toContain("script-src 'self' blob: 'wasm-unsafe-eval'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
  });
});
