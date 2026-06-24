import { test, expect } from '@playwright/test';

/** Canvas UX: the board is draggable + rotatable, and a wire can be recoloured / deleted. */

test('the MCU board can be moved and rotated', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  const board = page.locator('.part.board').first();
  await expect(board).toBeVisible({ timeout: 10_000 });

  const before = await board.boundingBox();
  // drag the board body by 80px
  await board.hover({ position: { x: 30, y: 20 } });
  await page.mouse.down();
  await page.mouse.move(before!.x + 30 + 80, before!.y + 20 + 40, { steps: 6 });
  await page.mouse.up();
  const after = await board.boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(30); // the board actually moved

  // selecting the board shows its rotate toolbar; rotate applies a transform to the element that OWNS
  // rotation — the wokwi host art inside .part.board (the rotate transform was moved there so the pin
  // dots pivot around the art's centre; .part.board itself stays untransformed). See rotation.spec.ts
  // for the stronger user-visible check (pin dots stay aligned with the board after rotating).
  await board.click({ position: { x: 30, y: 20 } });
  const tools = page.locator('.board-tools');
  await expect(tools).toBeVisible();
  const host = page.locator('.part.board .wokwi-host');
  await expect(host).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)'); // identity at 0° (rotate(0deg))
  await tools.getByRole('button', { name: 'Xoay phải' }).click();
  await expect(host).toHaveCSS('transform', /matrix\(0\.866/); // 30° rotation now applied to the board art
});

test('a wire can be recoloured and deleted', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-led').click();
  await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });

  // wire LED anode → D13
  await page.locator('circle.pin[data-cid="led-1"][data-pin="A"]').click({ force: true });
  await page.locator('circle.pin[data-cid="__board__"][data-pin="13"]').click({ force: true });
  await expect(page.locator('path.wire')).toHaveCount(1);

  // click the wire → toolbar; pick a colour → the stroke changes; delete → wire gone
  await page.locator('path.wire').first().click({ force: true });
  const wt = page.locator('.wire-tools');
  await expect(wt).toBeVisible();
  await wt.locator('.wswatch').nth(2).click(); // green
  await expect(page.locator('path.wire').first()).toHaveAttribute(
    'style',
    /rgb\(47, 158, 68\)|#2f9e44/i,
  );
  await page.locator('path.wire').first().click({ force: true });
  await page.locator('.wire-tools .wdel').click();
  await expect(page.locator('path.wire')).toHaveCount(0);
});
