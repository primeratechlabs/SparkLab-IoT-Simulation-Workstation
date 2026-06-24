import { test, expect } from '@playwright/test';

/**
 * Stage 7 e2e — UX hardening in the browser: a broken sketch surfaces a beginner-friendly hint
 * (the error translator) alongside the raw compiler message. Gated on the client toolchain being
 * present (it must actually compile + fail to produce the diagnostic).
 */
test.describe('Stage 7 — friendly compile errors', () => {
  test('a missing semicolon shows a plain-language hint in the Sim Lab', async ({ page }) => {
    const manifest = await page.request.get('/toolchain/manifest.json');
    test.skip(!manifest.ok(), 'toolchain fixtures absent — run `pnpm toolchain-fixtures`');

    await page.goto('/?view=labs');
    await page.getByTestId('tab-sim').click();
    await expect(page.getByTestId('led-state')).toBeVisible({ timeout: 60_000 });

    // a sketch missing a semicolon after `int x = 5`
    await page.getByTestId('code-editor').fill('void setup(){ int x = 5 }\nvoid loop(){}\n');
    await page.getByTestId('sim-compile-run').click();

    // the Stage-7 translator appends a plain-language hint under the raw compiler message
    await expect(page.getByTestId('compile-status')).toContainText('semicolon', {
      timeout: 110_000,
    });
  });
});
