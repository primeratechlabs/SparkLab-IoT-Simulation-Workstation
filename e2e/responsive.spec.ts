import { test, expect, type Page } from '@playwright/test';

/**
 * Responsive layout (AUD-028) — at every supported viewport the app must NOT scroll horizontally and the
 * primary controls must stay reachable: the start screen's board picker, and the workspace's editor + Run
 * button + canvas. Mobile/tablet collapse the multi-column workspace into a stacked, vertically-scrollable
 * column and let the toolbars wrap; this spec verifies it objectively at three widths.
 */
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

/** The document (and its scroll root) must not exceed the viewport width — i.e. no horizontal scrollbar. */
async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const { scrollW, clientW } = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(
    scrollW,
    `${where}: horizontal overflow (scrollWidth ${scrollW} > clientWidth ${clientW})`,
  ).toBeLessThanOrEqual(clientW + 2);
}

test.describe('responsive — no horizontal overflow + controls reachable (AUD-028)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} ${vp.width}×${vp.height}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // Start screen — board picker reachable, no sideways scroll.
      await page.goto('/');
      await expect(page.getByText('Bắt đầu một dự án mới')).toBeVisible();
      await expect(page.getByTestId('board-arduino-uno')).toBeVisible();
      await expectNoHorizontalOverflow(page, `${vp.name} start screen`);

      // Workspace — editor + Run + canvas reachable, no sideways scroll (stacked on narrow viewports).
      await page.getByTestId('board-arduino-uno').click();
      await expect(page.getByTestId('editor-code')).toBeVisible();
      await expect(page.getByTestId('ws-run')).toBeVisible();
      await expect(page.locator('.panel.circuit')).toBeVisible();
      await expectNoHorizontalOverflow(page, `${vp.name} workspace`);

      // Advanced labs (?view=labs) — fluid shell with a wrapping tab nav; must not overflow either.
      await page.goto('/?view=labs');
      await expect(page.getByTestId('labs-back')).toBeVisible();
      await expect(page.getByTestId('tab-capability')).toBeVisible();
      await expectNoHorizontalOverflow(page, `${vp.name} labs`);
    });
  }
});
