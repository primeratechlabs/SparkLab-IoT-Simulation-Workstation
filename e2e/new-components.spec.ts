import { test, expect, type Page } from '@playwright/test';

/**
 * System / manual-as-a-user check for the 11 newly-added wokwi devices: each appears in the parts library
 * and, when placed, mounts its real @wokwi/elements custom element on the canvas. Mirrors how a user
 * browses the drawer and drops parts.
 */
const NEW_PARTS: Array<{ type: string; tag: string }> = [
  { type: 'ds1307', tag: 'wokwi-ds1307' },
  { type: 'mpu6050', tag: 'wokwi-mpu6050' },
  { type: 'stepper-motor', tag: 'wokwi-stepper-motor' },
  { type: 'biaxial-stepper', tag: 'wokwi-biaxial-stepper' },
  { type: 'membrane-keypad', tag: 'wokwi-membrane-keypad' },
  { type: 'hx711', tag: 'wokwi-hx711' },
  { type: 'rotary-dialer', tag: 'wokwi-rotary-dialer' },
  { type: 'ir-receiver', tag: 'wokwi-ir-receiver' },
  { type: 'ir-remote', tag: 'wokwi-ir-remote' },
  { type: 'ili9341', tag: 'wokwi-ili9341' },
  { type: 'microsd-card', tag: 'wokwi-microsd-card' },
];

async function enter(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();
}

test('all 11 new parts appear in the library and mount their wokwi element when placed', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await enter(page);
  for (const { type, tag } of NEW_PARTS) {
    await page.getByTestId('canvas-add-part').click();
    // filter to the part so it's in view regardless of the 44-item list length
    await page.getByTestId('part-search').fill(type);
    const item = page.getByTestId(`part-${type}`);
    await expect(item, `library is missing part-${type}`).toBeVisible({ timeout: 10_000 });
    await item.click();
    await expect(page.locator(tag).first(), `${tag} did not mount`).toBeVisible({
      timeout: 10_000,
    });
  }
  // every device is on the canvas at once
  for (const { tag } of NEW_PARTS) {
    expect(await page.locator(tag).count(), tag).toBeGreaterThan(0);
  }
  await page.screenshot({ path: 'test-results/new-components.png', fullPage: false });
});
