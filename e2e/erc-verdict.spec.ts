import { test, expect } from '@playwright/test';

/**
 * Global circuit verdict (CMB-10): a damaging wiring fault (VCC↔GND short) shows an error verdict and
 * REFUSES to run — before any compile — instead of silently running an unsafe circuit. Runs without
 * the toolchain (the gate fires before the build).
 */
test('a VCC↔GND short shows an error verdict and blocks the run', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();

  // short the 5V rail directly to GND
  await page.locator('circle.pin[data-cid="__board__"][data-pin="5V"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="GND.1"]').click({ force: true });
  await expect(page.locator('path.wire')).toHaveCount(1);

  // the panel verdict flags an error
  await expect(page.getByTestId('circuit-verdict')).toContainText('lỗi');

  // Run is refused with a clear, actionable reason; never enters the running state. We assert the
  // INVARIANT (blocked + the fault named + a fix instruction), not exact copy: the message identifies
  // the power-short and tells the user to fix it, and the status never becomes running.
  await page.getByTestId('ws-run').click();
  const msg = page.getByTestId('ws-message');
  await expect(msg).toContainText('Không chạy', { timeout: 15_000 });
  await expect(msg).toContainText('power-short'); // the specific damaging fault is named
  await expect(msg).toContainText('Hãy sửa'); // a remediation instruction is shown
  await expect(page.getByTestId('ws-status')).not.toHaveAttribute('data-status', 'running');
});
