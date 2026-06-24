import { test, expect } from '@playwright/test';

/**
 * ESP32-classic (Xtensa) client-side run — Stage 5 in the product. A real ESP32-classic sketch
 * compiles 100% in the browser (Xtensa clang+lld WASM + the sim-profile HAL) and runs on the Xtensa
 * interpreter, with `backend=0`. Skips when the (gitignored, [CI/HUMAN]) Xtensa toolchain fixtures
 * are not staged (`pnpm esp32-classic-fixtures`).
 */
const XTENSA_PROBE = `void setup(){ Serial.begin(115200); pinMode(2, OUTPUT); }
void loop(){
#if defined(ARDUINO_ARCH_ESP32)
  Serial.println("ARCH_ESP32");
#else
  Serial.println("ARCH_OTHER");
#endif
  digitalWrite(2, HIGH); delay(5); digitalWrite(2, LOW); delay(5);
}`;

test('a real ESP32-classic sketch compiles + runs entirely in the browser (ARCH_ESP32, GPIO2)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  const staged = await page.evaluate(() =>
    fetch('/esp32-classic-toolchain/esp32-classic-sdk.json', { method: 'HEAD' })
      .then((r) => r.ok)
      .catch(() => false),
  );
  test.skip(!staged, 'Xtensa toolchain fixtures not staged — run `pnpm esp32-classic-fixtures`');

  await page.getByTestId('board-esp32-devkit').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();
  await page.getByTestId('editor-code').fill(XTENSA_PROBE);

  await page.getByTestId('ws-run').click();
  // first run loads the ~85MB clang+lld + SDK, then compiles — generous timeout
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'running', {
    timeout: 200_000,
  });
  // the firmware ran AS ESP32 (the arch macro) on the Xtensa backend — NOT a silent AVR compile
  await expect(page.getByTestId('serial-log')).toContainText('ARCH_ESP32', { timeout: 20_000 });
});
