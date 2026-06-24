import { test, expect, type Page } from '@playwright/test';

/**
 * Firmware→UI reflection (the user-reported bug). Running the blink sketch (digital pin 13 toggling),
 * the UI must reflect the REAL emulated GPIO state, net-traced to each component's actual wiring — no
 * hardcoded pin-13-lights-everything. Guards: (1) the on-board "L" LED (led13) follows pin 13;
 * (2) an UNWIRED placed LED stays dark even while pin 13 blinks; (3) an LED wired to D13 lights.
 */
function ledProp(page: Page, sel: string, prop: string): Promise<unknown> {
  return page
    .locator(sel)
    .first()
    .evaluate((el, p) => (el as unknown as Record<string, unknown>)[p], prop);
}

const ESP32_BLINK = `#define LED_PIN 2
void setup() { pinMode(LED_PIN, OUTPUT); }
void loop() { digitalWrite(LED_PIN, HIGH); delay(1000); digitalWrite(LED_PIN, LOW); delay(1000); }`;

const BTN_LED = `#define LED 13
#define BTN 2
void setup() { pinMode(LED, OUTPUT); pinMode(BTN, INPUT_PULLUP); }
void loop() { digitalWrite(LED, digitalRead(BTN) == LOW ? HIGH : LOW); }`;

test('the canvas reflects the real emulated pin state, per wiring — not a global pin-13 bool', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();

  // add an UNWIRED LED on the canvas
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-led').click();
  await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });

  // run the default blink sketch (toggles digital pin 13); client-side compile may take a while
  await page.getByTestId('ws-run').click();
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'running', {
    timeout: 150_000,
  });

  // (1) the on-board "L" LED (hardwired to D13) toggles with pin 13
  await expect
    .poll(() => ledProp(page, 'wokwi-arduino-uno', 'led13'), { timeout: 20_000, intervals: [150] })
    .toBe(true);

  // (2) the UNWIRED placed LED must NOT light (it used to blink off the global pin13)
  expect(await ledProp(page, 'wokwi-led', 'value')).toBe(false);

  // (3) wire a COMPLETE LED circuit (anode → D13, cathode → GND): only now may it light
  await page.locator('circle.pin[data-cid="led-1"][data-pin="A"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="13"]').click({ force: true });
  await page.locator('circle.pin[data-cid="led-1"][data-pin="C"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="GND.1"]').click({ force: true });
  await expect(page.locator('path.wire')).toHaveCount(2);
  await expect
    .poll(() => ledProp(page, 'wokwi-led', 'value'), { timeout: 20_000, intervals: [150] })
    .toBe(true);
});

test('an LED wired anode→pin but with NO GND return stays dark (polarity/return-path truth)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-led').click();
  await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });
  // anode → D13 only (no cathode → GND)
  await page.locator('circle.pin[data-cid="led-1"][data-pin="A"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="13"]').click({ force: true });
  await expect(page.getByTestId('part-issues')).toContainText('Cathode chưa nối GND');

  await page.getByTestId('ws-run').click();
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'running', {
    timeout: 150_000,
  });
  // pin 13 is toggling, but with no return path the LED must remain inert
  await page.waitForTimeout(2500);
  expect(await ledProp(page, 'wokwi-led', 'value')).toBe(false);
});

test('ESP32 classic (Xtensa) is never silently run on AVR — it builds as Xtensa, or errors clearly (P0-1)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  // Xtensa now has a client-side backend, but the toolchain fixtures are gitignored ([CI/HUMAN]).
  const staged = await page.evaluate(() =>
    fetch('/esp32-classic-toolchain/esp32-classic-sdk.json', { method: 'HEAD' })
      .then((r) => r.ok)
      .catch(() => false),
  );
  await page.getByTestId('board-esp32-devkit').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();
  await page.getByTestId('editor-code').fill(ESP32_BLINK);
  await expect(page.locator('wokwi-esp32-devkit-v1')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('ws-run').click();
  if (staged) {
    // compiles + runs AS Xtensa (never a silent AVR compile); full ARCH_ESP32 proof is in esp32-classic.spec
    await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'running', {
      timeout: 200_000,
    });
  } else {
    // no toolchain staged → a clear error, never a silent AVR compile / running state
    await expect(page.getByTestId('ws-status')).not.toHaveAttribute('data-status', 'running');
    expect(await ledProp(page, 'wokwi-esp32-devkit-v1', 'led1')).toBeFalsy();
  }
});

test('a wired button drives the firmware: holding it pulls D2 LOW → LED13 lights', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('editor-code').fill(BTN_LED);

  // place a button and wire a COMPLETE circuit: one terminal → D2 (read pin), the other → GND
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-button').click();
  await expect(page.locator('wokwi-pushbutton').first()).toBeVisible({ timeout: 10_000 });
  await page.locator('circle.pin[data-cid="button-1"][data-pin="1.l"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="2"]').click({ force: true });
  await page.locator('circle.pin[data-cid="button-1"][data-pin="2.l"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="GND.1"]').click({ force: true });
  await expect(page.locator('path.wire')).toHaveCount(2);

  await page.getByTestId('ws-run').click();
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'running', {
    timeout: 150_000,
  });
  // released → INPUT_PULLUP reads HIGH → LED off (the canvas pushes the resting state on start)
  await expect
    .poll(() => ledProp(page, 'wokwi-arduino-uno', 'led13'), { timeout: 12_000, intervals: [150] })
    .toBe(false);

  // press & hold → D2 LOW → LED13 on; release → off
  const btn = page.locator('.part[data-cid="button-1"]');
  await btn.hover();
  await page.mouse.down();
  await expect
    .poll(() => ledProp(page, 'wokwi-arduino-uno', 'led13'), { timeout: 12_000, intervals: [150] })
    .toBe(true);
  await page.mouse.up();
  await expect
    .poll(() => ledProp(page, 'wokwi-arduino-uno', 'led13'), { timeout: 12_000, intervals: [150] })
    .toBe(false);
});
