import { test, expect } from '@playwright/test';

/**
 * ESP32-C3 (RISC-V) client-side run — Stage 4 in the product. A real C3 sketch compiles 100% in the
 * browser (clang+lld WASM + sim-profile HAL) and runs on the rv32imc emulator, with `backend=0`.
 * Skips when the (gitignored, [CI/HUMAN]) C3 toolchain fixtures are not staged (`pnpm c3-fixtures`).
 */
const C3_PROBE = `void setup(){ Serial.begin(115200); pinMode(8, OUTPUT); }
void loop(){
#if defined(ARDUINO_ARCH_ESP32)
  Serial.println("ARCH_ESP32");
#else
  Serial.println("ARCH_OTHER");
#endif
  digitalWrite(8, HIGH); delay(5); digitalWrite(8, LOW); delay(5);
}`;

// SKIPPED while the ESP32-C3 board is in development: its Start-screen selection is disabled
// (boards.ts `wip: true`), so this UI→runtime flow is intentionally unreachable. The C3 engine itself
// stays covered by the unit suites (esp32c3-soc, the rv32 interpreter, cross-arch-parity). Re-enable
// this test together with the board (remove the wip flag).
test.skip('a real ESP32-C3 sketch compiles + runs entirely in the browser (ARCH_ESP32, GPIO8)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  const staged = await page.evaluate(() =>
    fetch('/c3-toolchain/c3-sdk.json', { method: 'HEAD' })
      .then((r) => r.ok)
      .catch(() => false),
  );
  test.skip(!staged, 'C3 toolchain fixtures not staged — run `pnpm c3-fixtures`');

  await page.getByTestId('board-esp32-c3-devkitm').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();
  await page.getByTestId('editor-code').fill(C3_PROBE);

  await page.getByTestId('ws-run').click();
  // first run loads the ~100MB clang+lld + SDK, then compiles — generous timeout
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'running', {
    timeout: 200_000,
  });
  // the firmware ran AS ESP32 (the arch macro) on the rv32 backend — NOT a silent AVR compile
  await expect(page.getByTestId('serial-log')).toContainText('ARCH_ESP32', { timeout: 20_000 });
});
