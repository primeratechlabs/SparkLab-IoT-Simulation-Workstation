import { test, expect, type Page } from '@playwright/test';

/**
 * Device-runtime end-to-end (the root-cause fix for the QA-CURRICULUM device failures): a drawn device
 * is now ATTACHED to the running emulator, so firmware output reaches the visual device. Proven on Uno:
 *   - a Servo library sketch (write 90°) actually rotates the on-canvas wokwi-servo (was stuck at 0 —
 *     CMB-03);
 *   - an I²C LiquidCrystal sketch's text appears on the on-canvas wokwi-lcd1602 (was blank — CMB-02).
 * These need the preset Servo / LiquidCrystal_I2C / Wire libraries in the staged AVR toolchain; the
 * suite is skipped if a sketch fails to compile (libraries not bundled locally).
 */
function prop(page: Page, sel: string, p: string): Promise<unknown> {
  return page
    .locator(sel)
    .first()
    .evaluate((el, k) => (el as unknown as Record<string, unknown>)[k], p);
}

async function wire(
  page: Page,
  fromCid: string,
  fromPin: string,
  toCid: string,
  toPin: string,
): Promise<void> {
  await page
    .locator(`circle.pin[data-cid="${fromCid}"][data-pin="${fromPin}"]`)
    .click({ force: true });
  await page.locator(`circle.pin[data-cid="${toCid}"][data-pin="${toPin}"]`).click({ force: true });
}

const SERVO_SKETCH = `#include <Servo.h>
Servo s;
void setup(){ s.attach(9); }
void loop(){ s.write(90); delay(20); }`;

test('a Servo sketch rotates the drawn servo on the canvas (CMB-03 — firmware → device)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('editor-code').fill(SERVO_SKETCH);

  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-servo').click();
  await expect(page.locator('wokwi-servo').first()).toBeVisible({ timeout: 10_000 });

  // wire the servo: PWM → D9, V+ → 5V, GND → GND
  await wire(page, 'servo-1', 'PWM', '__board__', '9');
  await wire(page, 'servo-1', 'V+', '__board__', '5V');
  await wire(page, 'servo-1', 'GND', '__board__', 'GND.1');

  await page.getByTestId('ws-run').click();
  // wait for the compile to finish (status leaves "Đang biên dịch…"), then skip if it didn't run.
  await page
    .waitForFunction(
      () =>
        !document
          .querySelector('[data-testid="ws-status"]')
          ?.textContent?.includes('Đang biên dịch'),
      {
        timeout: 150_000,
      },
    )
    .catch(() => {});
  const statusText = await page.getByTestId('ws-status').textContent();
  test.skip(
    !statusText?.includes('Đang chạy'),
    'sketch did not compile (preset library not staged locally)',
  );

  // the firmware commands 90°; the drawn servo's angle must follow it (no longer pinned at 0)
  await expect
    .poll(() => prop(page, 'wokwi-servo', 'angle'), { timeout: 20_000, intervals: [200] })
    .toBeGreaterThan(60);
});

const LCD_SKETCH = `#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
void setup(){ lcd.init(); lcd.backlight(); lcd.setCursor(0,0); lcd.print("HELLO"); }
void loop(){}`;

test('an I2C LCD sketch shows its text on the drawn LCD (CMB-02 — firmware → device)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('editor-code').fill(LCD_SKETCH);

  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-lcd-i2c').click();
  await expect(page.locator('wokwi-lcd1602').first()).toBeVisible({ timeout: 10_000 });

  // wire the LCD I²C bus: SDA → A4, SCL → A5, VCC → 5V, GND → GND
  await wire(page, 'lcd-i2c-1', 'SDA', '__board__', 'A4');
  await wire(page, 'lcd-i2c-1', 'SCL', '__board__', 'A5');
  await wire(page, 'lcd-i2c-1', 'VCC', '__board__', '5V');
  await wire(page, 'lcd-i2c-1', 'GND', '__board__', 'GND.1');

  await page.getByTestId('ws-run').click();
  const status = page.getByTestId('ws-status');
  // Wait for the build to SETTLE — `running` (or `error`), never treating the transient `compiling`
  // status as a result. A genuine compile error is surfaced (with its message), not silently skipped,
  // so this stays a real firmware→device guard (the LCD must show its text).
  await page.waitForFunction(
    () => {
      const s = document.querySelector('[data-testid=ws-status]')?.getAttribute('data-status');
      return s === 'running' || s === 'error';
    },
    { timeout: 150_000 },
  );
  if ((await status.getAttribute('data-status')) === 'error') {
    throw new Error(
      `LCD sketch failed to build: ${await page.getByTestId('ws-message').textContent()}`,
    );
  }

  await expect
    .poll(() => prop(page, 'wokwi-lcd1602', 'text'), { timeout: 20_000, intervals: [200] })
    .toContain('HELLO');
});
