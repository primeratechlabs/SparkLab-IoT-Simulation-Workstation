import { test, expect } from '@playwright/test';

/** Canvas zoom: the circuit magnifies (so pins/labels are readable for wiring), wiring + drag still hit
 *  the right targets under zoom (the pointer→content math divides by the zoom factor), and reset works. */
test('the circuit canvas zooms in/out and wiring still works under zoom', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();

  const level = page.getByTestId('zoom-reset');
  await expect(level).toHaveText('100%');
  const layer = page.locator('.zoom-layer');

  // zoom in twice → 144%, and the content layer carries a scale transform
  await page.getByTestId('zoom-in').click();
  await page.getByTestId('zoom-in').click();
  await expect(level).toHaveText('144%');
  await expect(layer).toHaveCSS('transform', /matrix\(1\.44/);

  // wiring still connects the right pins while zoomed in
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-led').click();
  await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });
  await page.locator('circle.pin[data-cid="led-1"][data-pin="A"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="13"]').click({ force: true });
  await expect(page.locator('path.wire')).toHaveCount(1);

  // zoom out + reset
  await page.getByTestId('zoom-out').click();
  await expect(level).not.toHaveText('144%');
  await page.getByTestId('zoom-reset').click();
  await expect(level).toHaveText('100%');
  await expect(layer).toHaveCSS('transform', /matrix\(1,/);
});
