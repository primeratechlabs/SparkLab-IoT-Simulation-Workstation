import { test, expect, type Page } from '@playwright/test';

/**
 * The vendored `<sparklab-breadboard>` element (wokwi-elements ships none) — verified only in a real
 * Chromium render: it appears in the palette, mounts as a custom element drawing its own SVG, and the
 * canvas overlays a wire-able pin dot on every one of its 400 holes (the row-net topology itself is
 * unit-tested in the canvas→document bridge). Mirrors canvas.spec.ts's part-add flow.
 */
async function enterWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();
}

test.describe('Breadboard — vendored <sparklab-breadboard>', () => {
  test('palette adds the breadboard; it renders an SVG with a pin dot per hole', async ({
    page,
  }) => {
    await enterWorkspace(page);
    await page.getByTestId('canvas-add-part').click();
    await expect(page.getByTestId('part-breadboard')).toBeVisible();
    await page.getByTestId('part-breadboard').click();

    // the custom element mounts and draws its own SVG (connectedCallback ran)
    await expect(page.locator('sparklab-breadboard').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('sparklab-breadboard svg').first()).toBeVisible();

    // the canvas overlays a wire-able pin dot on every hole (400 holes on a half board)
    const holes = page.locator('circle.pin[data-cid="breadboard-1"]');
    await expect(holes.first()).toBeVisible({ timeout: 10_000 });
    expect(await holes.count()).toBe(400);

    // the dots are spread across the board (distinct x positions), not collapsed at the origin
    const xs = await holes.evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().x)),
    );
    expect(new Set(xs).size).toBeGreaterThan(20);
  });
});
