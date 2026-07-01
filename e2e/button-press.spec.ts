import { test, expect, type Page } from '@playwright/test';

/**
 * The reported bug: "can't press the button". A pushbutton must be operable by a real pointer press in
 * EVERY state — not just while a sketch runs. These probes press the button with a genuine mouse gesture
 * (no force, no style hacks) and assert the wokwi element's own `pressed` state toggles, then that a
 * press-and-drag still relocates the part (so the always-live button is still draggable).
 */
async function enter(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();
}
async function addButton(page: Page): Promise<string> {
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-button').click();
  await expect(page.locator('wokwi-pushbutton').first()).toBeVisible({ timeout: 10_000 });
  return page
    .locator('.part wokwi-pushbutton')
    .evaluate((e) => (e.closest('.part') as HTMLElement).getAttribute('data-cid')!);
}
const pressed = (page: Page) =>
  page
    .locator('wokwi-pushbutton')
    .first()
    .evaluate((e) => (e as unknown as { pressed: boolean }).pressed);
const domeCenter = (page: Page) =>
  page
    .locator('wokwi-pushbutton')
    .first()
    .evaluate((e) => {
      const r = (e as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot
        .querySelector('button')!
        .getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

test('edit mode (not running): a real press toggles the button — no "dead button" before Run', async ({
  page,
}) => {
  await enter(page);
  await addButton(page);
  expect(await pressed(page)).toBe(false);
  const c = await domeCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  expect(await pressed(page)).toBe(true); // the dome depresses immediately, before any simulation
  await page.mouse.up();
  expect(await pressed(page)).toBe(false);
});

test('a stationary press never drags the part, but a press-and-move does', async ({ page }) => {
  await enter(page);
  await addButton(page);
  const before = await page.locator('.part wokwi-pushbutton').evaluate((e) => {
    const r = (e.closest('.part') as HTMLElement).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  });
  // stationary press → no move
  const c = await domeCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
  const afterTap = await page.locator('.part wokwi-pushbutton').evaluate((e) => {
    const r = (e.closest('.part') as HTMLElement).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  });
  expect(Math.abs(afterTap.x - before.x) + Math.abs(afterTap.y - before.y)).toBeLessThan(3);
  // press-and-move → drags
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 40, { steps: 8 });
  await page.mouse.up();
  const afterDrag = await page.locator('.part wokwi-pushbutton').evaluate((e) => {
    const r = (e.closest('.part') as HTMLElement).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  });
  expect(Math.abs(afterDrag.x - before.x) + Math.abs(afterDrag.y - before.y)).toBeGreaterThan(40);
});

test('button plugged into a breadboard stays pressable', async ({ page }) => {
  await enter(page);
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-breadboard').click();
  await expect(page.locator('sparklab-breadboard').first()).toBeVisible({ timeout: 10_000 });
  const cid = await addButton(page);

  const leg = await page.locator(`circle.pin[data-cid="${cid}"][data-pin="1.l"]`).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const hole = await page
    .locator('circle.pin[data-cid="breadboard-1"][data-pin="f5"]')
    .evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  const body = await page.locator(`.part[data-cid="${cid}"]`).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(body.x, body.y);
  await page.mouse.down();
  await page.mouse.move(body.x + (hole.x - leg.x), body.y + (hole.y - leg.y), { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const c = await domeCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  expect(await pressed(page)).toBe(true);
  await page.mouse.up();
  expect(await pressed(page)).toBe(false);
});
