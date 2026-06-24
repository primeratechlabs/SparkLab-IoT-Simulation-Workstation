import { defineConfig, devices } from '@playwright/test';

/**
 * Stage 0 acceptance harness. Runs against the Vite dev server, which sets the
 * COOP/COEP/CORP headers (invariant I1) so real Chromium is cross-origin isolated
 * — enabling SharedArrayBuffer, threaded WASM, OPFS sync handles and SQLite-WASM.
 * Fixtures (signed ≥50MB sample pack + trusted keys) are regenerated before serving.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5180',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'pnpm fixtures && (pnpm toolchain-fixtures || true) && pnpm --filter @sparklab/app dev',
    url: 'http://localhost:5180',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
