import { test, expect } from '@playwright/test';

/**
 * Board rotation keeps the pin dots ON the board art (regression for the display:inline bug). A wokwi board
 * element defaults to display:inline, whose box collapses to a baseline strip — so dims/pinAbs measured the
 * wrong size and `transform-origin: center` resolved wrong, and rotating the board flung its pin dots far
 * off the rendered SVG. With `.wokwi-host { display: inline-block }` the rotate centre matches the measured
 * centre. This asserts that after a board rotation every board pin dot still sits within the board's art.
 */
test.describe('canvas — board rotation keeps pins aligned with the art', () => {
  test('ESP32 DevKit: pin dots stay on the board after rotating', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('board-esp32-devkit').click();
    await page.waitForTimeout(1500); // wokwi board element renders + pins are measured
    await page.locator('.part.board').click({ position: { x: 18, y: 18 } }); // select → rotate toolbar shows

    // Every pin dot must lie within the board art's bounding box (pins are on the perimeter; allow a margin).
    const dotsOnBoard = async (): Promise<{ total: number; onBoard: number }> =>
      page.evaluate(() => {
        const host = document.querySelector('.part.board .wokwi-host') as HTMLElement | null;
        if (!host) return { total: 0, onBoard: 0 };
        const b = host.getBoundingClientRect();
        const M = 14; // px margin (a pin dot has radius + sits just inside/outside the silhouette)
        const dots = [
          ...document.querySelectorAll('circle.pin[data-cid="__board__"]'),
        ] as SVGElement[];
        let onBoard = 0;
        for (const c of dots) {
          const r = c.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          if (cx >= b.x - M && cx <= b.x + b.width + M && cy >= b.y - M && cy <= b.y + b.height + M)
            onBoard++;
        }
        return { total: dots.length, onBoard };
      });

    const before = await dotsOnBoard();
    expect(before.total, 'board should expose pin dots').toBeGreaterThan(4);
    expect(before.onBoard, 'all pin dots on the board before rotation').toBe(before.total);

    // rotate the board a few steps (30° each) and re-check the dots still track the art.
    for (let i = 0; i < 3; i++) await page.getByTitle('Xoay phải 30°').click();
    await page.waitForTimeout(400);
    const after = await dotsOnBoard();
    expect(after.total).toBe(before.total);
    expect(after.onBoard, 'all pin dots still on the board after rotating (no fly-off)').toBe(
      after.total,
    );
  });
});
