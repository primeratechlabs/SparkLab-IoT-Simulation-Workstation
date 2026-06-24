import { test, expect } from '@playwright/test';

test.describe('Stage 3 — off-main-thread workbench render (gate #4)', () => {
  test('GATE #4 — logic analyzer renders in a worker; UI stays ≥30 FPS, main thread responsive', async ({
    page,
  }) => {
    await page.goto('/?view=labs');
    await page.getByTestId('tab-workbench').click();

    // The OffscreenCanvas render worker is drawing off the main thread while the sim runs.
    await expect(page.getByTestId('render-mode')).toContainText('OffscreenCanvas worker');
    await expect(page.getByTestId('wb-running')).toHaveText('running', { timeout: 30_000 });
    await page.waitForFunction(
      () => Number(document.querySelector('[data-testid=render-frames]')?.textContent) > 30,
      { timeout: 20_000 },
    );

    // Observe the main thread for ~2s while the sim + render run: no long tasks allowed.
    const { maxLongTaskMs } = await page.evaluate(async () => {
      const durations: number[] = [];
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) durations.push(e.duration);
      });
      obs.observe({ entryTypes: ['longtask'] });
      await new Promise((r) => setTimeout(r, 2000));
      obs.disconnect();
      return { maxLongTaskMs: durations.length ? Math.max(...durations) : 0 };
    });

    const fps = Number(await page.getByTestId('ui-fps').textContent());
    const framesAfter = Number(await page.getByTestId('render-frames').textContent());

    expect(fps, `UI ran at ${fps} FPS`).toBeGreaterThanOrEqual(30); // main thread stayed smooth
    expect(maxLongTaskMs, `longest main-thread task ${maxLongTaskMs}ms`).toBeLessThan(50);
    expect(framesAfter, 'worker kept rendering off-thread').toBeGreaterThan(60);

    // Virtual time advanced (the sim is genuinely running behind the render).
    const vtime = parseInt((await page.getByTestId('wb-vtime').textContent()) ?? '0', 10);
    expect(vtime).toBeGreaterThan(0);
  });

  test('Workbench cleanup stops the shared sim worker when leaving the tab', async ({ page }) => {
    await page.goto('/?view=labs');
    await page.getByTestId('tab-workbench').click();
    await expect(page.getByTestId('wb-running')).toHaveText('running', { timeout: 30_000 });

    await page.getByTestId('tab-capability').click();

    await page.waitForFunction(async () => {
      const sim = (globalThis as { __sparklabSim?: { getState(): Promise<{ running: boolean }> } })
        .__sparklabSim;
      if (!sim) return false;
      return !(await sim.getState()).running;
    });
  });

  test('degrades gracefully when OffscreenCanvas is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
        value: undefined,
        configurable: true,
      });
    });
    await page.goto('/?view=labs');
    await page.getByTestId('tab-workbench').click();
    await expect(page.getByTestId('wb-error')).toContainText('OffscreenCanvas is unavailable');
    await expect(page.getByTestId('wb-running')).toHaveText('stopped');
  });
});
