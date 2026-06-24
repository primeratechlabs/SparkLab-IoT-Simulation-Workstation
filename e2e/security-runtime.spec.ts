import { test, expect } from '@playwright/test';

/**
 * Runtime security/invariants in a real browser — the new product UI must stay 100% self-hosted (the
 * source design loaded wokwi + Google Fonts from CDNs) AND cross-origin isolated. Asserts: zero CDN /
 * third-party requests during a full start→workspace load (wokwi chunk included), crossOriginIsolated
 * + SharedArrayBuffer available (COOP/COEP working), and every font is same-origin.
 */
const CDN_HOSTS = [
  'unpkg.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'esm.sh',
  'skypack.dev',
];

test.describe('Mạch Ảo — runtime security', () => {
  test('no CDN requests, cross-origin isolated, fonts self-hosted', async ({ page, baseURL }) => {
    const external: string[] = [];
    const fonts: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (CDN_HOSTS.some((h) => u.includes(h))) external.push(u);
      if (u.endsWith('.woff2') || u.endsWith('.woff')) fonts.push(u);
    });

    await page.goto('/');
    await expect(page.getByText('Bắt đầu một dự án mới')).toBeVisible();
    await page.getByTestId('board-arduino-uno').click(); // load the lazy wokwi canvas chunk too
    await expect(page.getByTestId('editor-code')).toBeVisible();
    await page.getByTestId('canvas-add-part').click();
    await page.getByTestId('part-led').click();
    await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });

    expect(external, `external CDN requests:\n${external.join('\n')}`).toEqual([]);

    const isolated = await page.evaluate(
      () =>
        globalThis.crossOriginIsolated === true &&
        typeof globalThis.SharedArrayBuffer === 'function',
    );
    expect(isolated, 'crossOriginIsolated + SharedArrayBuffer').toBe(true);

    const origin = new URL(baseURL ?? 'http://localhost:5180').origin;
    for (const f of fonts) expect(f.startsWith(origin), `non-self-hosted font: ${f}`).toBe(true);
    expect(fonts.length, 'at least one bundled font loaded').toBeGreaterThan(0);
  });
});
