import { test, expect } from '@playwright/test';

/**
 * Mobile/responsive canvas controls — permanent guards for the fixes in CLAUDE_CODE_TEST_ISSUES.md:
 *  - Issue 11: a selected part's toolbar stays inside the viewport (was rendered off-screen on phones).
 *  - Issue 14: the editor header tabs stay reachable at narrow widths (was clipped by panel overflow).
 *  - Issue 15: the canvas opts INTO native touch pan, while parts/pins opt OUT (so drag/wire still work).
 *  - Issue 16: the part drawer filters by search (the catalog has grown past 30 items).
 */
test.describe('responsive canvas controls (mobile 375×667)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('Issue 11 — the selected-part toolbar stays within the viewport, actions clickable', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    await page.getByTestId('canvas-add-part').click();
    await page.getByTestId('part-led').click();
    await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });

    await page.locator('.part[data-cid="led-1"]').click({ position: { x: 8, y: 8 } });
    const toolbar = page.locator('.toolbar');
    await expect(toolbar).toBeVisible();
    const box = await toolbar.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375 + 1); // wholly inside the viewport width
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(667 + 1);
    // a toolbar action actually works from this position
    await page.getByTestId('tool-rotate-cw').click();
    await expect(page.locator('.part[data-cid="led-1"] .wokwi-host')).toHaveCSS(
      'transform',
      /matrix/,
    );
  });

  test('Issue 15 — canvas allows native touch pan; parts + pins opt out so drag/wire survive', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    await expect(page.getByTestId('editor-code')).toBeVisible();
    // the scroll container opts INTO native pan; parts/pins keep touch-action:none so their gestures win.
    await expect(page.locator('.canvas-scroll')).toHaveCSS('touch-action', 'pan-x pan-y');
    await page.getByTestId('canvas-add-part').click();
    await page.getByTestId('part-led').click();
    await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.part[data-cid="led-1"]')).toHaveCSS('touch-action', 'none');
  });

  test('Issue 16 — the part drawer filters by search, then resets after adding', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    await page.getByTestId('canvas-add-part').click();
    await expect(page.getByTestId('part-led')).toBeVisible();
    await page.getByTestId('part-search').fill('breadboard');
    await expect(page.getByTestId('part-breadboard')).toBeVisible();
    await expect(page.getByTestId('part-led')).toHaveCount(0); // non-matching parts are filtered out
    await page.getByTestId('part-search').fill('zzz-no-such-part');
    await expect(page.getByTestId('part-empty')).toBeVisible();
    // clear → full list; add a part → the next drawer open is NOT stuck on the old query (Issue 16 fix).
    await page.getByTestId('part-search').fill('breadboard');
    await page.getByTestId('part-breadboard').click();
    await page.getByTestId('canvas-add-part').click();
    await expect(page.getByTestId('part-led')).toBeVisible(); // full library again, not filtered
  });
});

test('Issue 11 — the toolbar re-clamps into the viewport when the canvas shrinks', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-led').click();
  await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });
  await page.locator('.part[data-cid="led-1"]').click({ position: { x: 8, y: 8 } });
  await expect(page.locator('.toolbar')).toBeVisible();

  // Shrink the viewport (the canvas viewport shrinks → the ResizeObserver re-syncs + re-clamps). This is
  // the same path a WorkspaceShell gutter drag exercises (the circuit panel resizing, not the window).
  await page.setViewportSize({ width: 420, height: 800 });
  await page.waitForTimeout(150);
  const box = await page.locator('.toolbar').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(420 + 1); // re-clamped inside the now-narrow viewport
});

test.describe('responsive editor header', () => {
  for (const vp of [
    { width: 375, height: 667 },
    { width: 1024, height: 768 },
  ]) {
    test(`Issue 14 — editor tabs stay reachable at ${vp.width}×${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto('/');
      await page.getByTestId('board-arduino-uno').click();
      await expect(page.getByTestId('editor-code')).toBeVisible();
      // both editor tabs are visible + the library tab is clickable (not clipped by panel overflow)
      await expect(page.getByTestId('tab-code')).toBeVisible();
      await expect(page.getByTestId('tab-libs')).toBeVisible();
      await page.getByTestId('tab-libs').click();
      await expect(page.getByTestId('lib-dropzone')).toBeVisible();
    });
  }
});

test('PR-04 — the inspector does not overlap the zoom controls on a small phone (320×568)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await page.getByTestId('canvas-add-part').click();
  await page.getByTestId('part-led').click();
  await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });
  await page.locator('.part[data-cid="led-1"]').click({ position: { x: 8, y: 8 } });
  await expect(page.locator('.inspector-dock')).toBeVisible();
  const insp = (await page.locator('.inspector-dock').boundingBox())!;
  const zoom = (await page.locator('.zoom-ctl').boundingBox())!;
  const overlap =
    insp.x < zoom.x + zoom.width &&
    insp.x + insp.width > zoom.x &&
    insp.y < zoom.y + zoom.height &&
    insp.y + insp.height > zoom.y;
  expect(overlap, 'inspector and zoom controls must not intersect').toBe(false);
});

test('PR-05 — the running appbar stays compact on a small phone (single status text, 320×568)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();
  await page.getByTestId('ws-run').click();
  await page.waitForFunction(
    () => {
      const s = document.querySelector('[data-testid=ws-status]')?.getAttribute('data-status');
      return s === 'running' || s === 'error';
    },
    { timeout: 150_000 },
  );
  test.skip(
    (await page.getByTestId('ws-status').getAttribute('data-status')) !== 'running',
    'default sketch did not compile (toolchain not staged)',
  );
  // the appbar must not eat a third of a phone screen while running (PR-05)
  const appbar = (await page.locator('.appbar').boundingBox())!;
  expect(appbar.height, 'running appbar height on a 568px screen').toBeLessThan(150);
  await expect(page.getByTestId('ws-stop')).toBeVisible();
  // a SINGLE compact status node — not both the full + compact strings
  const statusText = (await page.getByTestId('ws-status').textContent()) ?? '';
  expect(statusText).toContain('Đang chạy');
  expect(statusText, 'compact form only, no duplicated full copy').not.toContain('firmware thật');
  // no document-level horizontal overflow
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal overflow').toBeLessThanOrEqual(2);
});
