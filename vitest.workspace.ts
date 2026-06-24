import { defineWorkspace, configDefaults } from 'vitest/config';

// Two projects:
//  - 'unit'  — pure logic + WebCrypto + worker_threads packages in NODE (jsdom would change globals).
//  - 'app'   — the Vue app (composables/components) in JSDOM, so window/timers + @vue/test-utils work.
// Browser-only surfaces (OPFS, SQLite-WASM, crossOriginIsolated, SAB, custom-element render) remain
// covered by the Playwright e2e suite under /e2e, not here.
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.test.ts', 'services/*/src/**/*.test.ts'],
      exclude: [...configDefaults.exclude, '**/packages/app/**'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'app',
      root: './packages/app',
      include: ['src/**/*.test.ts'],
      environment: 'happy-dom',
    },
  },
]);
