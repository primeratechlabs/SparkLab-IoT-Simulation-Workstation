import { chromium, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const baseURL = process.env.BASE_URL ?? 'http://localhost:5180';
const outDir = process.env.QA_OUT_DIR ?? join(tmpdir(), 'sparklab-manual-qa');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADLESS === '1',
  slowMo: Number(process.env.SLOW_MO_MS ?? 70),
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(err.message));
page.on('requestfailed', (req) =>
  failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`),
);

async function step(name, fn) {
  console.log(`\n[manual-qa] ${name}`);
  await fn();
  await page.screenshot({
    path: join(outDir, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`),
    fullPage: true,
  });
}

async function waitNumber(testId, minimum, timeout = 30_000) {
  await page.waitForFunction(
    ({ testId: id, minimum: min }) => {
      const n = Number(
        globalThis.document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/[^0-9.-]/g, '') ?? 'NaN',
      );
      return n >= min;
    },
    { testId, minimum },
    { timeout },
  );
}

try {
  await step('capability-desktop', async () => {
    await page.goto(baseURL);
    await expect(page.getByTestId('coi-banner-ok')).toContainText('Cross-origin isolated');
    await expect(page.getByTestId('profile-ready')).toHaveText('ready', { timeout: 60_000 });
    await expect(page.getByTestId('cap-coi')).toHaveText('true');
    await expect(page.getByTestId('cap-sab')).toHaveText('true');
    await expect(page.getByTestId('fs-backend')).toHaveText('opfs');
  });

  await step('mobile-layout-no-overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth - globalThis.window.innerWidth,
    );
    expect(overflow, `horizontal overflow ${overflow}px`).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 950 });
  });

  await step('pack-install-reuse-probe', async () => {
    await page.getByTestId('tab-pack').click();
    await page.getByTestId('evict-btn').click();
    await page.getByTestId('install-btn').click();
    await expect(page.getByTestId('install-status')).toContainText(/installed|reused/, {
      timeout: 60_000,
    });
    await waitNumber('pack-count', 1);
    const value = `manual-${Date.now()}`;
    await page.getByTestId('probe-input').fill(value);
    await page.getByTestId('probe-set-btn').click();
    await expect(page.getByTestId('probe-saved')).toHaveText('saved');
    await page.reload();
    await page.getByTestId('tab-pack').click();
    await page.getByTestId('probe-get-btn').click();
    await expect(page.getByTestId('probe-value')).toHaveText(value);
    await page.getByTestId('install-btn').click();
    await expect(page.getByTestId('install-status')).toHaveText('reused', { timeout: 30_000 });
  });

  await step('build-cache-edit-reset', async () => {
    await page.getByTestId('tab-build').click();
    await page.getByTestId('build-btn').click();
    await expect(page.getByTestId('build-elf-valid')).toHaveText('true', { timeout: 30_000 });
    await expect(page.getByTestId('build-diagnostics')).toHaveText('0');
    await page.getByTestId('build-btn').click();
    await expect(page.getByTestId('build-reused')).not.toHaveText('—', { timeout: 30_000 });
    await page.getByTestId('edit-build-btn').click();
    await expect(page.getByTestId('build-compiled')).toContainText('main.cpp', { timeout: 30_000 });
    await page.getByTestId('reset-project-btn').click();
  });

  await step('sim-fixture-run-stop', async () => {
    await page.getByTestId('tab-sim').click();
    await page.getByTestId('sim-run').click();
    await waitNumber('led-toggles', 2, 30_000);
    await expect(page.getByTestId('serial-output')).toContainText('blink');
    await page.getByTestId('sim-stop').click();
    await expect(page.getByTestId('sim-running')).toHaveText('stopped', { timeout: 10_000 });
  });

  await step('sim-client-compile-and-interactions', async () => {
    await page.getByTestId('preset-select').selectOption('LED + Servo + pot + button');
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText(
      /Compiled client-side|Loaded cached firmware/,
      { timeout: 120_000 },
    );
    await page.getByTestId('pot-a0').fill('1023');
    await page.waitForFunction(
      () => {
        const text =
          globalThis.document.querySelector('[data-testid="serial-output"]')?.textContent ?? '';
        const angles = [...text.matchAll(/angle=(\d+)/g)].map((m) => Number(m[1]));
        return angles.at(-1) >= 165;
      },
      { timeout: 20_000 },
    );
    await page.getByTestId('button-d2').dispatchEvent('mousedown');
    await expect(page.getByTestId('led-state')).toHaveText('on', { timeout: 20_000 });
    await page.getByTestId('button-d2').dispatchEvent('mouseup');
    await expect(page.getByTestId('led-state')).toHaveText('off', { timeout: 20_000 });

    for (const raw of ['0', '512', '1023', '256', '768']) {
      await page.getByTestId('pot-a0').fill(raw);
    }
  });

  await step('sim-all-presets-compile', async () => {
    for (const preset of [
      'Blink',
      'I2C LCD (LiquidCrystal_I2C + Wire)',
      'DHT22 sensor (DHT + Adafruit Unified Sensor)',
    ]) {
      await page.getByTestId('preset-select').selectOption(preset);
      await page.getByTestId('sim-compile-run').click();
      await expect(page.getByTestId('compile-status')).toContainText(
        /Compiled client-side|Loaded cached firmware/,
        {
          timeout: 120_000,
        },
      );
    }
  });

  await step('sim-invalid-code-error-and-recovery', async () => {
    await page
      .getByTestId('code-editor')
      .fill(
        '#error <img src=x onerror="globalThis.__qaXss=1"> manual qa failure\nvoid setup(){}\nvoid loop(){}',
      );
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText(
      /manual qa failure|compile failed|error/i,
      { timeout: 60_000 },
    );
    expect(await page.evaluate(() => globalThis.__qaXss)).toBeUndefined();

    await page.getByTestId('preset-select').selectOption('Blink');
    await page.getByTestId('sim-compile-run').click();
    await expect(page.getByTestId('compile-status')).toContainText(
      /Compiled client-side|Loaded cached firmware/,
      {
        timeout: 120_000,
      },
    );
  });

  await step('workbench-render-and-cleanup', async () => {
    await page.getByTestId('tab-workbench').click();
    await expect(page.getByTestId('wb-running')).toHaveText('running', { timeout: 30_000 });
    await waitNumber('render-frames', 31, 20_000);
    await waitNumber('ui-fps', 30, 20_000);
    await page.getByTestId('tab-capability').click();
    await page.waitForFunction(async () => {
      const sim = globalThis.__sparklabSim;
      if (!sim) return false;
      return !(await sim.getState()).running;
    });
  });

  await step('workbench-repeated-lifecycle-stress', async () => {
    for (let i = 0; i < 8; i++) {
      await page.getByTestId('tab-workbench').click();
      await expect(page.getByTestId('wb-running')).toHaveText('running', { timeout: 30_000 });
      await waitNumber('render-frames', 3, 10_000);
      await page.getByTestId('tab-capability').click();
      await page.waitForFunction(async () => {
        const sim = globalThis.__sparklabSim;
        return sim ? !(await sim.getState()).running : false;
      });
    }
  });

  if (consoleErrors.length || pageErrors.length || failedRequests.length) {
    throw new Error(JSON.stringify({ consoleErrors, pageErrors, failedRequests }, null, 2));
  }

  console.log(`\n[manual-qa] PASS. Screenshots: ${outDir}`);
} finally {
  await browser.close();
}
