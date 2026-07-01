import { test, expect } from '@playwright/test';
import { waterScenario, WATER_SCENARIO_SKETCH } from '../packages/app/src/lib/esp32-water-scenario.fixture';

/**
 * Renders the sparse ESP32 + water-level-sensor demo, routes its wires orthogonally, and verifies the
 * design's wire-colour convention on the LIVE canvas: at least one charcoal GND wire (#3B3530), one red
 * power wire (#D7503B), and palette-coloured signals — plus a screenshot of the clean, low-density layout.
 */
const scn = waterScenario();
const base = {
  version: 2,
  boardId: 'esp32-devkit',
  name: 'esp32_water_demo',
  sketch: WATER_SCENARIO_SKETCH,
  canvas: { placed: scn.placed, wires: scn.wires, boardPos: { x: 40, y: 220 }, boardRot: 0 },
};

test('water-level scenario: role-coloured wires + clean layout', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1680, height: 1000 });

  await page.goto('/');
  await page.evaluate((p) => localStorage.setItem('sparklab:project', JSON.stringify(p)), base);
  await page.reload();
  await expect(page.locator('wokwi-esp32-devkit-v1')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('sparklab-water-sensor')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1200);

  const pins = await page.evaluate(() => {
    const out: Record<string, { x: number; y: number }> = {};
    for (const c of Array.from(document.querySelectorAll('circle.pin, .bb-holes circle'))) {
      const cid = (c as HTMLElement).dataset.cid;
      const pin = (c as HTMLElement).dataset.pin;
      const cx = c.getAttribute('cx');
      const cy = c.getAttribute('cy');
      if (cid && pin && cx && cy) out[`${cid} ${pin}`] = { x: +cx, y: +cy };
    }
    return out;
  });
  const G = 8;
  const snap = (v: number) => Math.round(v / G) * G;
  const routed = base.canvas.wires.map((w) => {
    const a = pins[`${w.from.cid} ${w.from.pin}`];
    const b = pins[`${w.to.cid} ${w.to.pin}`];
    const points = a && b && Math.abs(a.x - b.x) > G && Math.abs(a.y - b.y) > G ? [{ x: snap(b.x), y: snap(a.y) }] : [];
    return { ...w, points };
  });
  await page.evaluate(
    (p) => localStorage.setItem('sparklab:project', JSON.stringify(p)),
    { ...base, canvas: { ...base.canvas, wires: routed } },
  );
  await page.reload();
  await expect(page.locator('sparklab-water-sensor')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await page.getByTestId('zoom-fit').click().catch(() => undefined);
  await page.waitForTimeout(500);

  // read the stroke colour of every committed wire on the live canvas
  const colors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('path.wire')).map(
      (p) => (p as SVGPathElement).style.stroke || p.getAttribute('stroke') || '',
    ),
  );
  const norm = (c: string) => c.replace(/\s/g, '').toLowerCase();
  const set = new Set(colors.map(norm));
  console.log('WATER wire colours:', [...set].join(' '));
  expect([...set].some((c) => c.includes('3b3530') || c === 'rgb(59,53,48)'), 'a charcoal GND wire').toBe(true);
  expect([...set].some((c) => c.includes('d7503b') || c === 'rgb(215,80,59)'), 'a red power wire').toBe(true);
  // signals use the palette — at least one green/blue/amber present beyond GND+power
  expect(set.size, 'more than just GND + power → signals are palette-coloured').toBeGreaterThanOrEqual(3);

  await page.locator('.canvas').screenshot({ path: 'test-results/water-scenario.png' });
});
