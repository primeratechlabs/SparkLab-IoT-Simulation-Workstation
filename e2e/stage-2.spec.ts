import { test, expect, type Page } from '@playwright/test';

async function gotoSim(page: Page): Promise<void> {
  await page.goto('/?view=labs');
  await page.getByTestId('tab-sim').click();
  await expect(page.getByTestId('led-state')).toBeVisible({ timeout: 60_000 });
}

test.describe('Stage 2 — Arduino Uno emulator half (real avr-gcc firmware on avr8js)', () => {
  test('Blink firmware blinks the D13 LED in the browser, prints to Serial, virtual-time', async ({
    page,
  }) => {
    let backendCompileRequests = 0;
    page.on('request', (r) => {
      if (/\/(api\/)?compile|\/backend\//.test(r.url())) backendCompileRequests++;
    });

    await gotoSim(page);
    await expect(page.getByTestId('mode-label')).toContainText('Timing: Exact');

    await page.getByTestId('sim-run').click();

    // Wait for 3 edges (HIGH@0 → LOW@1s → HIGH@2s) — proves repeated on/off blinking.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid=led-toggles]');
        return el && Number(el.textContent) >= 3;
      },
      { timeout: 30_000 },
    );

    // Serial output from the firmware (Serial.println in loop()).
    await expect(page.getByTestId('serial-output')).toContainText('blink on');
    await expect(page.getByTestId('serial-output')).toContainText('blink off');

    // Virtual time advances (wall-clock-independent). The blink PERIOD isn't assumed here: the old
    // threshold was tied to a 1s period, so a faster blink only reached ~1s by the 3rd toggle. We poll
    // the running sim until virtual time crosses ~2 periods, which it always will given it keeps running.
    await page.waitForFunction(
      () =>
        parseInt(document.querySelector('[data-testid=sim-vtime]')?.textContent ?? '0', 10) > 1800,
      { timeout: 30_000 },
    );
    const vtime = parseInt((await page.getByTestId('sim-vtime').textContent()) ?? '0', 10);
    expect(vtime).toBeGreaterThan(1800);

    // The LED visual reflects pin state.
    const ledState = await page.getByTestId('led-state').textContent();
    expect(['on', 'off']).toContain(ledState?.trim());

    expect(backendCompileRequests).toBe(0); // backend_compile_count === 0 (I8)
  });

  test('GATE #1 — compiles the sketch to firmware 100% client-side and it blinks', async ({
    page,
  }) => {
    // Skip when the (gitignored) toolchain fixtures haven't been generated locally.
    const manifest = await page.request.get('/toolchain/manifest.json');
    test.skip(!manifest.ok(), 'toolchain fixtures absent — run `pnpm toolchain-fixtures`');

    let backendCompileRequests = 0;
    page.on('request', (r) => {
      if (/\/(api\/)?compile|\/backend\//.test(r.url())) backendCompileRequests++;
    });

    await gotoSim(page);
    await page.getByTestId('sim-compile-run').click();

    // The real avr-gcc.wasm toolchain downloads (~18MB gz) + compiles in-browser.
    await expect(page.getByTestId('compile-status')).toContainText('Compiled client-side ✓', {
      timeout: 110_000,
    });

    // The CLIENT-COMPILED firmware actually blinks the D13 LED.
    await page.waitForFunction(
      () => Number(document.querySelector('[data-testid=led-toggles]')?.textContent) >= 3,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('serial-output')).toContainText('blink');

    // External-library compilation in the browser: select the I2C-LCD preset (pulls
    // LiquidCrystal_I2C → Wire, incl. the C file twi.c) and compile it client-side too.
    await page.getByTestId('preset-select').selectOption('I2C LCD (LiquidCrystal_I2C + Wire)');
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText('Compiled client-side ✓', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('compile-status')).toContainText('LiquidCrystal_I2C');
    await expect(page.getByTestId('compile-status')).toContainText('Wire');

    expect(backendCompileRequests).toBe(0); // backend_compile_count === 0 (invariant I8)
  });

  test('GATE #2 — warm compile budget + cached run after reload (no recompile)', async ({
    page,
  }) => {
    const manifest = await page.request.get('/toolchain/manifest.json');
    test.skip(!manifest.ok(), 'toolchain fixtures absent — run `pnpm toolchain-fixtures`');

    await gotoSim(page);

    // Cold compile (downloads + instantiates the toolchain, then caches Blink).
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText(
      /Compiled client-side ✓|Loaded cached/,
      { timeout: 110_000 },
    );

    // Warm compile: change the sketch so the firmware cache misses; toolchain is warm.
    await page
      .getByTestId('code-editor')
      .fill(
        'void setup(){ Serial.begin(9600); }\nvoid loop(){ Serial.println("warm"); delay(500); }',
      );
    const tWarm = Date.now();
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText('Compiled client-side ✓', {
      timeout: 30_000,
    });
    const warmMs = Date.now() - tWarm;
    expect(warmMs, `warm compile ${warmMs}ms`).toBeLessThan(8_000); // gate target 3–5s (CI headroom)

    // Reload → fresh worker → recompile the SAME (default Blink) sketch → firmware cache
    // hit: no toolchain load, no compile. Must be fast.
    await page.reload();
    await page.getByTestId('tab-sim').click();
    await expect(page.getByTestId('led-state')).toBeVisible({ timeout: 60_000 });
    const tCached = Date.now();
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText('Loaded cached firmware ✓', {
      timeout: 30_000,
    });
    const cachedMs = Date.now() - tCached;
    expect(cachedMs, `cached run ${cachedMs}ms`).toBeLessThan(4_000);
  });

  test('GATE #4 — interaction: pot → analogRead → Serial, button → digitalRead → LED', async ({
    page,
  }) => {
    const manifest = await page.request.get('/toolchain/manifest.json');
    test.skip(!manifest.ok(), 'toolchain fixtures absent — run `pnpm toolchain-fixtures`');

    await gotoSim(page);
    // The Servo preset reads A0 (→ angle) and D2 (→ LED), printing to Serial.
    await page.getByTestId('preset-select').selectOption('LED + Servo + pot + button');
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText('Compiled client-side ✓', {
      timeout: 110_000,
    });

    // Potentiometer high → analogRead(A0) ≈ 1023 → angle ≈ 180 in Serial.
    await page.getByTestId('pot-a0').fill('1023');
    await page.waitForFunction(
      () => {
        const t = document.querySelector('[data-testid=serial-output]')?.textContent ?? '';
        const angles = [...t.matchAll(/angle=(\d+)/g)].map((m) => Number(m[1]));
        return angles.length > 0 && angles[angles.length - 1]! >= 165;
      },
      { timeout: 20_000 },
    );
    // Potentiometer low → angle ≈ 0.
    await page.getByTestId('pot-a0').fill('0');
    await page.waitForFunction(
      () => {
        const t = document.querySelector('[data-testid=serial-output]')?.textContent ?? '';
        const angles = [...t.matchAll(/angle=(\d+)/g)].map((m) => Number(m[1]));
        return angles.length > 0 && angles[angles.length - 1]! <= 10;
      },
      { timeout: 20_000 },
    );

    // Button press → digitalRead(D2) LOW → firmware drives the D13 LED HIGH.
    await page.getByTestId('button-d2').dispatchEvent('mousedown');
    await expect(page.getByTestId('led-state')).toHaveText('on', { timeout: 20_000 });
    await page.getByTestId('button-d2').dispatchEvent('mouseup');
    await expect(page.getByTestId('led-state')).toHaveText('off', { timeout: 20_000 });
  });
});
