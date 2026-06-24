import { test, expect, type Page } from '@playwright/test';

/**
 * Component attributes + sensor behaviour. The inspector is data-driven from the catalog `properties`
 * (no per-component code), so every component's editable attributes appear and bind to the wokwi
 * element. Passive analog sensors (LDR/NTC) get a stimulus slider that injects a live ADC reading
 * into the running firmware.
 */
function prop(page: Page, sel: string, p: string): Promise<unknown> {
  return page
    .locator(sel)
    .first()
    .evaluate((el, k) => (el as unknown as Record<string, unknown>)[k], p);
}

const LDR_SKETCH = `#define LED 13
void setup() { pinMode(LED, OUTPUT); }
void loop() { digitalWrite(LED, analogRead(A0) > 512 ? HIGH : LOW); }`;

test('the inspector edits a resistor Ω (colour bands) and an LED colour, driven by the catalog', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();

  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-resistor').click();
  await expect(page.locator('wokwi-resistor').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('inspector')).toBeVisible(); // auto-selected on placement
  await page.getByTestId('prop-ohms').fill('470');
  await expect.poll(() => prop(page, 'wokwi-resistor', 'value')).toBe('470'); // drives the bands

  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-led').click();
  await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('prop-color').selectOption('blue');
  await expect.poll(() => prop(page, 'wokwi-led', 'color')).toBe('blue');
});

test('lcd-i2c renders the 4 I²C pins (SDA/SCL/VCC/GND) so it can actually be wired (R1)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-lcd-i2c').click();
  await expect(page.locator('wokwi-lcd1602').first()).toBeVisible({ timeout: 10_000 });
  // pins="i2c" → the SDA + SCL hit targets exist (the parallel-pin LCD has none)
  await expect(page.locator('circle.pin[data-cid="lcd-i2c-1"][data-pin="SDA"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('circle.pin[data-cid="lcd-i2c-1"][data-pin="SCL"]')).toBeVisible();
});

test('an unwired servo shows engine readiness issues in the inspector (R3)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-servo').click();
  await expect(page.locator('wokwi-servo').first()).toBeVisible({ timeout: 10_000 });
  // servo is auto-selected on placement; with no wires the engine flags missing rails/signal
  await expect(page.getByTestId('part-issues')).toContainText('Thiếu GND');
});

test('the inspector surfaces the schematic ERC engine (no series resistor) — product uses the engine (P1-5)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-led').click();
  await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });
  // a complete LED but with NO series resistor: anode → D13, cathode → GND
  await page.locator('circle.pin[data-cid="led-1"][data-pin="A"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="13"]').click({ force: true });
  await page.locator('circle.pin[data-cid="led-1"][data-pin="C"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="GND.1"]').click({ force: true });
  // 'dễ quá dòng' is emitted ONLY by the schematic ERC engine (runErc led-no-resistor), via the bridge
  await expect(page.getByTestId('part-issues')).toContainText('dễ quá dòng');
});

test('an LDR stimulus slider injects a live ADC reading into the running firmware', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('editor-code').fill(LDR_SKETCH);

  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-ldr').click();
  await expect(page.locator('wokwi-photoresistor-sensor').first()).toBeVisible({ timeout: 10_000 });
  // wire a COMPLETE LDR circuit: AO → A0, VCC → 5V, GND → GND (a sensor needs its rails)
  const wire = async (partPin: string, boardPin: string) => {
    await page
      .locator(`circle.pin[data-cid="ldr-1"][data-pin="${partPin}"]`)
      .click({ force: true });
    await page
      .locator(`circle.pin[data-cid="__board__"][data-pin="${boardPin}"]`)
      .click({ force: true });
  };
  await wire('AO', 'A0');
  await wire('VCC', '5V');
  await wire('GND', 'GND.1');
  await expect(page.locator('path.wire')).toHaveCount(3);
  await expect(page.getByTestId('sensor-stim')).toBeVisible(); // appears once wired to an ADC channel

  await page.getByTestId('ws-run').click();
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'running', {
    timeout: 150_000,
  });

  // bright (raw 1000 > 512) → LED13 on ; dark (raw 100) → off
  await page.getByTestId('sensor-stim').fill('1000');
  await expect
    .poll(() => prop(page, 'wokwi-arduino-uno', 'led13'), { timeout: 12_000, intervals: [150] })
    .toBe(true);
  await page.getByTestId('sensor-stim').fill('100');
  await expect
    .poll(() => prop(page, 'wokwi-arduino-uno', 'led13'), { timeout: 12_000, intervals: [150] })
    .toBe(false);
});
