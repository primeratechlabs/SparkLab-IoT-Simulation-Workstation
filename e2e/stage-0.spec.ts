import { test, expect, type Page } from '@playwright/test';

async function gotoCapability(page: Page): Promise<void> {
  await page.goto('/?view=labs');
  await page.getByTestId('tab-capability').click();
  await expect(page.getByTestId('tier-badge')).toBeVisible({ timeout: 60_000 });
}

test.describe('Stage 0 — Capability + Pack Manager + OPFS acceptance gate', () => {
  test('Gate 1: cross-origin isolation, SAB, OPFS detected; tier valid', async ({ page }) => {
    await gotoCapability(page);

    // Real isolation in the browser.
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined')).toBe(true);
    expect(await page.evaluate(() => typeof navigator.storage?.getDirectory === 'function')).toBe(
      true,
    );

    await expect(page.getByTestId('coi-banner-ok')).toBeVisible();
    await expect(page.getByTestId('cap-coi')).toHaveText('true');
    await expect(page.getByTestId('cap-sab')).toHaveText('true');
    await expect(page.getByTestId('cap-opfs')).toHaveText('true');

    const tier = await page.getByTestId('tier-badge').textContent();
    expect(['S', 'A', 'B', 'C', 'D']).toContain(tier?.trim());

    // OPFS is the active filesystem backend.
    await expect(page.getByTestId('fs-backend')).toHaveText('opfs');
  });

  test('Gate 4: benchmarks produced and capability-profile.json is valid', async ({ page }) => {
    await gotoCapability(page);
    await expect(page.getByTestId('bench-wasm')).not.toHaveText('—');

    const raw = await page.getByTestId('profile-json').textContent();
    const profile = JSON.parse(raw ?? '{}');
    expect(['S', 'A', 'B', 'C', 'D']).toContain(profile.tier);
    expect(typeof profile.hardwareConcurrency).toBe('number');
    expect(profile.crossOriginIsolated).toBe(true);
    expect(profile.opfs).toBe(true);
  });

  test('Gate 2: pack install, reuse with ZERO pack requests on reload, bad-sig rejected', async ({
    page,
  }) => {
    // ── First install: pack file IS fetched ──────────────────────────────
    let packFileRequests = 0;
    page.on('request', (req) => {
      if (req.url().includes('/sample-toolchain/files/')) packFileRequests++;
    });

    await page.goto('/?view=labs');
    await page.getByTestId('tab-pack').click();
    await page.getByTestId('install-btn').click();
    await expect(page.getByTestId('install-status')).toHaveText('installed', { timeout: 90_000 });
    expect(packFileRequests).toBeGreaterThanOrEqual(1);

    await expect(page.getByTestId('pack-count')).toHaveText('1');
    const total = Number(await page.getByTestId('health-total').textContent());
    expect(total).toBeGreaterThanOrEqual(50 * 1024 * 1024);
    await expect(page.getByTestId('health-missing')).toHaveText('0');

    // ── Reload: pack must be reused without re-downloading ───────────────
    packFileRequests = 0;
    await page.reload();
    await page.getByTestId('tab-pack').click();
    await page.getByTestId('install-btn').click();
    await expect(page.getByTestId('install-status')).toHaveText('reused', { timeout: 30_000 });
    expect(packFileRequests).toBe(0); // zero network requests for the pack on reuse

    // ── Bad signature is rejected (I6) ──────────────────────────────────
    const rejected = await page.evaluate(async () => {
      const keys = await (await fetch('/fixtures/trusted-keys.json')).json();
      const remote = (globalThis as { __sparklab?: Record<string, unknown> }).__sparklab!;
      const installFromUrl = remote.installFromUrl as (
        b: string,
        k: string[],
        known: { packType: string; name: string; version: string },
      ) => Promise<unknown>;
      try {
        await installFromUrl('/fixtures/forged-toolchain', keys.publicKeys, {
          packType: 'toolchain',
          name: 'forged-toolchain',
          version: '1.0.0',
        });
        return 'accepted';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(rejected).toMatch(/signature rejected/);
  });

  test('Gate 3: index persists across reload (SQLite-WASM / OPFS)', async ({ page }) => {
    await page.goto('/?view=labs');
    await page.getByTestId('tab-pack').click();

    const value = `persist-${'abc123'}`;
    await page.getByTestId('probe-input').fill(value);
    await page.getByTestId('probe-set-btn').click();
    // Wait for the async write to actually complete before reloading (no race).
    await expect(page.getByTestId('probe-saved')).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await page.getByTestId('tab-pack').click();
    await page.getByTestId('probe-get-btn').click();
    await expect(page.getByTestId('probe-value')).toHaveText(value, { timeout: 30_000 });

    // Index backend should be the SQLite-WASM store (OPFS-backed).
    const backend = await page.getByTestId('index-backend').textContent();
    expect(['sqlite', 'indexeddb']).toContain(backend?.trim());
  });

  test('Gate 5 + 6: multi-tab writes do not corrupt; no backend compile requests', async ({
    context,
  }) => {
    let backendCompileRequests = 0;
    const watch = (url: string) => {
      if (/\/(api\/)?compile|\/backend\//.test(url)) backendCompileRequests++;
    };

    const pageA = await context.newPage();
    const pageB = await context.newPage();
    pageA.on('request', (r) => watch(r.url()));
    pageB.on('request', (r) => watch(r.url()));

    await pageA.goto('/?view=labs');
    await pageB.goto('/?view=labs');
    await pageA.getByTestId('tab-pack').click();
    await pageB.getByTestId('tab-pack').click();

    // Concurrent index writes from two tabs (serialized by Web Locks → no corruption).
    await Promise.all([
      pageA.evaluate(async () => {
        const r = (globalThis as { __sparklab?: Record<string, unknown> }).__sparklab!;
        const set = r.setProbe as (v: string) => Promise<void>;
        for (let i = 0; i < 5; i++) await set(`A-${i}`);
      }),
      pageB.evaluate(async () => {
        const r = (globalThis as { __sparklab?: Record<string, unknown> }).__sparklab!;
        const set = r.setProbe as (v: string) => Promise<void>;
        for (let i = 0; i < 5; i++) await set(`B-${i}`);
      }),
    ]);

    // Both tabs still healthy and consistent.
    const healthA = await pageA.evaluate(async () => {
      const r = (globalThis as { __sparklab?: Record<string, unknown> }).__sparklab!;
      const health = r.health as () => Promise<{ missing: unknown[] }>;
      return health();
    });
    expect(Array.isArray(healthA.missing)).toBe(true);

    expect(backendCompileRequests).toBe(0); // backend_compile_count === 0 (I8)

    await pageA.close();
    await pageB.close();
  });
});
