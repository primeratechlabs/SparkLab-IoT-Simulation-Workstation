/**
 * Production security headers — THE single source of truth, plain ESM with NO Vite/Vue imports so
 * the standalone prod server (server.mjs), the deploy verifier, and the static-host / nginx
 * generators can all import the exact same values. vite.config.ts re-exports these.
 *
 * Cross-origin isolation (COOP+COEP+CORP) is required for SharedArrayBuffer / threaded WASM / OPFS
 * sync access handles (invariant I1) — a host that drops these silently breaks the client compiler
 * and emulator. The CSP is self-host-only: 'wasm-unsafe-eval' for WebAssembly compilation, blob: for
 * the toolchain's worker module imports, and connect-src for the user's IoT endpoints (Stage 6); no
 * 'unsafe-eval', no third-party scripts.
 */
export const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // data: covers the few Cyrillic-subset @fontsource woff2 that Vite inlines as data: URIs (small
  // assets under assetsInlineLimit); a data: font cannot execute, so this is a negligible relaxation
  // and stops a real CSP console violation. The primary fonts stay self-hosted as /assets/*.woff2.
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
];

export const cspHeader = { 'Content-Security-Policy': cspDirectives.join('; ') };

/** Every production response header (COOP/COEP/CORP + CSP), for the Node prod server. */
export const securityHeaders = { ...coiHeaders, ...cspHeader };
