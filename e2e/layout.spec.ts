import { test, expect, type Locator } from '@playwright/test';

/** The workspace layout: the editor column defaults to ~1/3 of the width (the circuit gets the rest),
 *  and the gutters between editor↔circuit and circuit↔serial drag to resize (persisted, double-click resets). */
async function widthOf(loc: Locator): Promise<number> {
  return (await loc.boundingBox())!.width;
}
async function heightOf(loc: Locator): Promise<number> {
  return (await loc.boundingBox())!.height;
}

test('the workspace panels default to editor≈1/3 and resize by dragging the gutters', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('board-arduino-uno').click();
  await expect(page.getByTestId('editor-code')).toBeVisible();

  const editor = page.locator('.panel.editor');
  const circuit = page.locator('.panel.circuit');
  const serial = page.locator('.panel.serial');

  // default: editor is about a third of the editor+circuit width (and clearly narrower than the circuit)
  const e0 = await widthOf(editor);
  const c0 = await widthOf(circuit);
  const frac = e0 / (e0 + c0);
  expect(frac).toBeGreaterThan(0.25);
  expect(frac).toBeLessThan(0.42);
  expect(e0).toBeLessThan(c0);

  // drag the vertical gutter right by 200px → the editor widens, the circuit narrows
  const gcol = page.getByTestId('gutter-col');
  const gb = (await gcol.boundingBox())!;
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + 200, gb.y + gb.height / 2, { steps: 8 });
  await page.mouse.up();
  const e1 = await widthOf(editor);
  expect(e1).toBeGreaterThan(e0 + 100); // editor got meaningfully wider
  expect(await widthOf(circuit)).toBeLessThan(c0);

  // double-click the gutter → reset back toward the ~1/3 default
  await gcol.dblclick();
  const e2 = await widthOf(editor);
  expect(e2).toBeLessThan(e1 - 80);

  // drag the horizontal gutter up by 120px → the serial panel grows taller
  const s0 = await heightOf(serial);
  const grow = page.getByTestId('gutter-row');
  const rb = (await grow.boundingBox())!;
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2, rb.y - 120, { steps: 8 });
  await page.mouse.up();
  expect(await heightOf(serial)).toBeGreaterThan(s0 + 60);
});
