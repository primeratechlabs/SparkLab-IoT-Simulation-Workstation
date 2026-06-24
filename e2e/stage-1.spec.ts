import { test, expect, type Page } from '@playwright/test';

async function gotoBuild(page: Page): Promise<void> {
  await page.goto('/?view=labs');
  await page.getByTestId('tab-build').click();
  await expect(page.getByTestId('build-btn')).toBeEnabled({ timeout: 60_000 });
}

test.describe('Stage 1 — Browser Build Daemon acceptance gate', () => {
  test('Gates 1/2/3/5/6: warm daemon, valid ELF, cache reuse + reproducibility across reload', async ({
    page,
  }) => {
    let backendCompileRequests = 0;
    page.on('request', (r) => {
      if (/\/(api\/)?compile|\/backend\//.test(r.url())) backendCompileRequests++;
    });

    await gotoBuild(page);

    // First build: both units compiled, valid ELF, single warm instantiation.
    await page.getByTestId('build-btn').click();
    await expect(page.getByTestId('build-elf-valid')).toHaveText('true', { timeout: 60_000 });
    await expect(page.getByTestId('build-compiled')).toContainText('main.cpp');
    await expect(page.getByTestId('build-compiled')).toContainText('util.cpp');
    await expect(page.getByTestId('build-reused')).toHaveText('—');
    await expect(page.getByTestId('build-instantiations')).toHaveText('1');

    const firmwareKey = (await page.getByTestId('build-firmware-key').textContent())?.trim();
    expect(firmwareKey).toMatch(/^sha256:/);

    // Second build (same session): all reused, still one instantiation (warm).
    await page.getByTestId('build-btn').click();
    await expect(page.getByTestId('build-reused')).toContainText('util.cpp');
    await expect(page.getByTestId('build-compiled')).toHaveText('—');
    await expect(page.getByTestId('build-instantiations')).toHaveText('1');

    // Reload: objects persist in OPFS → reuse without recompiling, identical firmware key.
    await page.reload();
    await expect(page.getByTestId('tab-build')).toBeVisible(); // app re-mounted after reload
    await page.getByTestId('tab-build').click();
    await expect(page.getByTestId('build-btn')).toBeEnabled({ timeout: 60_000 }); // daemon re-warmed
    await page.getByTestId('build-btn').click();
    await expect(page.getByTestId('build-elf-valid')).toHaveText('true', { timeout: 60_000 });
    await expect(page.getByTestId('build-reused')).toContainText('main.cpp');
    await expect(page.getByTestId('build-reused')).toContainText('util.cpp');
    await expect(page.getByTestId('build-compiled')).toHaveText('—');
    await expect(page.getByTestId('build-firmware-key')).toHaveText(firmwareKey!);

    expect(backendCompileRequests).toBe(0); // backend_compile_count === 0 (I8)
  });

  test('Gate 2: editing one source recompiles only that unit', async ({ page }) => {
    await gotoBuild(page);
    await page.getByTestId('build-btn').click();
    await expect(page.getByTestId('build-elf-valid')).toHaveText('true', { timeout: 60_000 });

    await page.getByTestId('edit-build-btn').click();
    await expect(page.getByTestId('build-compiled')).toHaveText('main.cpp');
    await expect(page.getByTestId('build-reused')).toHaveText('util.cpp');
  });

  test('Gate 4: dependency scan pulls the right library on a new #include', async ({ page }) => {
    await gotoBuild(page);
    const libs = await page.evaluate(async () => {
      const remote = (globalThis as { __sparklabBuild?: Record<string, unknown> }).__sparklabBuild!;
      await (remote.setupSampleProject as (s: boolean) => Promise<void>)(true);
      return (remote.scanLibraries as () => Promise<string[]>)();
    });
    expect(libs).toContain('Servo');
  });
});
