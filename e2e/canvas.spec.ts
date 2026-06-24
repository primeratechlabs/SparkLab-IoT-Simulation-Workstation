import { test, expect, type Page } from '@playwright/test';

/**
 * Circuit canvas (wokwi-elements + useCircuitCanvas) in real Chromium — the parts that can only be
 * verified with a real custom-element render: parts render as <wokwi-*>, drag moves them, pin dots
 * land at distinct (transformed) positions, clicking two pins draws a wire, removing a part cascades
 * its wires, and the ESP32-C3 fallback vs the wokwi ESP32 board.
 */
async function enterWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();
}

test.describe('Mạch Ảo — circuit canvas', () => {
  test('palette adds a part that renders as a wokwi element, and dragging moves it', async ({
    page,
  }) => {
    await enterWorkspace(page);
    await page.getByTestId('canvas-add-part').click();
    await expect(page.getByTestId('part-led')).toBeVisible();
    await expect(page.getByTestId('part-resistor')).toBeVisible();
    await page.getByTestId('part-led').click();
    await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });

    const wrapper = page.locator('.part[data-cid="led-1"]');
    const before = await wrapper.boundingBox();
    await wrapper.hover();
    await page.mouse.down();
    await page.mouse.move(before!.x + 130, before!.y + 70, { steps: 8 });
    await page.mouse.up();
    const after = await wrapper.boundingBox();
    expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(20);
  });

  test('board pin dots land ON the board, within its bounds (not flung off by a bad transform)', async ({
    page,
  }) => {
    await enterWorkspace(page);
    await page.waitForSelector('wokwi-arduino-uno', { timeout: 15_000 });
    const boardPins = page.locator('circle.pin[data-cid="__board__"]');
    await expect(boardPins.first()).toBeVisible({ timeout: 10_000 });
    // reference the positioned wrapper (the wokwi custom element is display:inline → its boundingBox
    // is unreliable). The board art is ~280×220; pins must sit close to the wrapper origin, NOT flung
    // hundreds of px to the right (the viewBox-scaling bug pushed them ~3.5× off).
    const board = await page.locator('.part.board').boundingBox();
    const dots = await boardPins.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    );
    expect(dots.length).toBeGreaterThan(10); // Uno exposes ~24 header pins
    for (const d of dots) {
      expect(d.x).toBeGreaterThanOrEqual(board!.x - 14);
      expect(d.x).toBeLessThanOrEqual(board!.x + 320);
      expect(d.y).toBeGreaterThanOrEqual(board!.y - 14);
      expect(d.y).toBeLessThanOrEqual(board!.y + 280);
    }
    expect(new Set(dots.map((d) => Math.round(d.x))).size).toBeGreaterThan(3); // distinct, not collapsed
  });

  test('clicking two pins draws a wire (count + clear); removing the part cascades its wire', async ({
    page,
  }) => {
    await enterWorkspace(page);
    await page.getByTestId('canvas-add-part').click();
    await page.getByTestId('part-led').click();
    await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('circle.pin').first()).toBeVisible({ timeout: 10_000 });
    // wire a LED pin to a board pin so removing the LED cascades the wire
    await page.locator('circle.pin[data-cid="led-1"]').first().click({ force: true });
    await page.locator('circle.pin[data-cid="__board__"]').first().click({ force: true });
    await expect(page.locator('path.wire')).toHaveCount(1);
    await expect(page.getByText('1 dây nối')).toBeVisible();

    // the LED is selected after placement → its floating toolbar can delete it (cascading the wire)
    await page.getByTestId('tool-delete').click();
    await expect(page.locator('wokwi-led')).toHaveCount(0);
    await expect(page.locator('path.wire')).toHaveCount(0);
    await expect(page.getByText('0 dây nối')).toBeVisible();
  });

  test('a selected part rotates 30° via the floating toolbar', async ({ page }) => {
    await enterWorkspace(page);
    await page.getByTestId('canvas-add-part').click();
    await page.getByTestId('part-resistor').click();
    await expect(page.locator('wokwi-resistor').first()).toBeVisible({ timeout: 10_000 });
    const host = page.locator('.part[data-cid="resistor-1"] .wokwi-host');
    await expect(host).toHaveCount(1);
    await page.getByTestId('tool-rotate-cw').click();
    await page.getByTestId('tool-rotate-cw').click();
    // two 30° steps → the element carries a 60° CSS rotation
    await expect(host).toHaveAttribute('style', /rotate\(60deg\)/);
  });

  // SKIPPED while ESP32-C3 is in development (boards.ts `wip: true` disables its Start-screen
  // selection). The custom-board rendering is still unit-tested via useCircuitCanvas with the C3
  // board ref. Re-enable with the board.
  test.skip('ESP32-C3 renders a wireable custom board (catalog pins); ESP32 classic uses the wokwi board', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('board-esp32-c3-devkitm').click();
    await expect(page.getByTestId('editor-code')).toBeVisible();
    // P0-2: the C3 has no wokwi element → we draw it from BOARD_CATALOG with real pin hit targets
    await expect(page.locator('circle.pin[data-cid="__board__"][data-pin="GPIO8"]')).toBeVisible({
      timeout: 10_000,
    });
    expect(await page.locator('circle.pin[data-cid="__board__"]').count()).toBeGreaterThan(10);
    // and it is functionally wireable: an LED pin → GPIO8 forms a wire
    await page.getByTestId('canvas-add-part').click();
    await page.getByTestId('part-led').click();
    await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });
    const ledAnode = page.locator('circle.pin[data-cid="led-1"][data-pin="A"]');
    const gpio8 = page.locator('circle.pin[data-cid="__board__"][data-pin="GPIO8"]');
    await expect(ledAnode).toBeVisible({ timeout: 10_000 }); // LED pins measured
    await expect(gpio8).toBeVisible({ timeout: 10_000 }); // board re-measured after the add settled
    await page.waitForTimeout(300);
    await ledAnode.click({ force: true });
    await gpio8.click({ force: true });
    await expect(page.locator('path.wire')).toHaveCount(1);

    await page.getByTestId('ws-back').click();
    await page.getByTestId('board-esp32-devkit').click();
    await expect(page.locator('wokwi-esp32-devkit-v1')).toBeVisible({ timeout: 10_000 });
  });
});
