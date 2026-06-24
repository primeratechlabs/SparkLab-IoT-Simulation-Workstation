/**
 * Manual-style walkthrough in REAL Microsoft Edge — a human clicks through every lab
 * and feature, and we assert each one actually works AND that the browser reports ZERO
 * console errors / page errors / failed requests (accessible to every user, no surprises).
 * Screenshots of each step are written to the test output dir for visual inspection.
 */
import { test, expect, type ConsoleMessage } from '@playwright/test';

test.use({ channel: 'msedge' });
test.describe.configure({ timeout: 240_000 });

test.describe('Microsoft Edge — full manual walkthrough', () => {
  test('a real user exercises every lab with zero browser errors', async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
      else if (m.type() === 'warning') consoleWarnings.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    page.on('requestfailed', (r) => {
      const u = r.url();
      if (!u.includes('favicon') && r.failure()?.errorText !== 'net::ERR_ABORTED') {
        failedRequests.push(`${u} — ${r.failure()?.errorText}`);
      }
    });
    const shot = async (name: string): Promise<void> => {
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
    };

    // ── 1. Home (engine labs behind the new product UI) ──
    await page.goto('/?view=labs');
    await expect(page.locator('h1')).toContainText('Advanced labs');
    expect(
      (await page.getByTestId('coi-banner-ok').count()) +
        (await page.getByTestId('coi-banner').count()),
    ).toBeGreaterThan(0);
    await shot('01-home');

    // ── 2. Capability Lab ──
    await page.getByTestId('tab-capability').click();
    await expect(page.getByTestId('tier-badge')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('tier-badge')).toHaveText(/^[A-F]/);
    await expect(page.getByTestId('cap-coi')).toHaveText('true');
    await expect(page.getByTestId('cap-opfs')).toHaveText('true');
    await expect(page.getByTestId('bench-wasm')).not.toHaveText('—'); // benchmark produced a number
    await expect(page.getByTestId('fs-backend')).toHaveText('opfs');
    // Downloading the capability profile must not error.
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-profile').click(),
    ]);
    expect(dl.suggestedFilename()).toContain('profile');
    await shot('02-capability');

    // ── 3. Pack Lab ── install a signed pack, probe the persistent index ──
    await page.getByTestId('tab-pack').click();
    await page.getByTestId('install-btn').click();
    await expect(page.getByTestId('install-status')).toHaveText(/installed|reused/, {
      timeout: 90_000,
    });
    await expect(page.getByTestId('pack-count')).not.toHaveText('0');
    await page.getByTestId('probe-input').fill('hello-edge');
    await page.getByTestId('probe-set-btn').click();
    await expect(page.getByTestId('probe-saved')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('probe-get-btn').click();
    await expect(page.getByTestId('probe-value')).toHaveText('hello-edge', { timeout: 30_000 });
    await page.getByTestId('reload-health-btn').click();
    await expect(page.getByTestId('health-total')).toBeVisible();
    await shot('03-pack');

    // ── 4. Build Lab ── warm build daemon: build, then edit + incremental rebuild ──
    await page.getByTestId('tab-build').click();
    await expect(page.getByTestId('build-btn')).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId('build-btn').click();
    await expect(page.getByTestId('build-elf-valid')).toHaveText('true', { timeout: 60_000 });
    await expect(page.getByTestId('build-firmware-key')).toContainText('sha256:');
    await page.getByTestId('edit-build-btn').click();
    await page.getByTestId('build-btn').click();
    await expect(page.getByTestId('build-reused')).toContainText('util.cpp', { timeout: 60_000 }); // incremental
    await shot('04-build');

    // ── 5. Sim Lab ── compile a sketch 100% client-side, run it, interact, swap a preset ──
    await page.getByTestId('tab-sim').click();
    await expect(page.getByTestId('led-state')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText(
      /Compiled client-side ✓|Loaded cached firmware ✓/,
      { timeout: 120_000 },
    );
    await page.waitForFunction(
      () => Number(document.querySelector('[data-testid=led-toggles]')?.textContent) >= 2,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('serial-output')).toContainText('blink');
    await page.getByTestId('pot-a0').fill('768');
    await page.getByTestId('button-d2').dispatchEvent('mousedown');
    await page.getByTestId('button-d2').dispatchEvent('mouseup');
    await shot('05a-sim-blink');
    // A library preset must also compile client-side.
    await page.getByTestId('preset-select').selectOption('I2C LCD (LiquidCrystal_I2C + Wire)');
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText('LiquidCrystal_I2C', {
      timeout: 120_000,
    });
    await shot('05b-sim-lcd');

    // ── 6. Workbench ── off-main-thread logic-analyzer render ──
    await page.getByTestId('tab-workbench').click();
    await expect(page.getByTestId('wb-running')).toHaveText('running', { timeout: 30_000 });
    await page.waitForFunction(
      () => Number(document.querySelector('[data-testid=render-frames]')?.textContent) > 20,
      { timeout: 20_000 },
    );
    // The main-thread FPS counter publishes once per second — wait for its first window.
    await page.waitForFunction(
      () => Number(document.querySelector('[data-testid=ui-fps]')?.textContent) > 0,
      { timeout: 5_000 },
    );
    expect(Number(await page.getByTestId('ui-fps').textContent())).toBeGreaterThanOrEqual(30);
    await shot('06-workbench');

    // ── verdict: the browser must be clean for every user ──
    console.log(`Edge walkthrough: ${consoleWarnings.length} warnings (informational)`);
    if (consoleWarnings.length) console.log('warnings:\n' + consoleWarnings.join('\n'));
    expect(pageErrors, `PAGE ERRORS:\n${pageErrors.join('\n')}`).toEqual([]);
    expect(failedRequests, `FAILED REQUESTS:\n${failedRequests.join('\n')}`).toEqual([]);
    expect(consoleErrors, `CONSOLE ERRORS:\n${consoleErrors.join('\n')}`).toEqual([]);
  });
});
