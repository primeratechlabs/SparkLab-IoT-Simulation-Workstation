import { test, expect } from '@playwright/test';

/**
 * Workstation UI (the Mạch Ảo product shell) — the start → workspace → canvas flow. Toolchain-free:
 * it exercises navigation, the editor, and the wokwi canvas rendering a part, without compiling
 * (the compile→sim path is covered by the toolchain-gated stage specs via ?view=labs).
 */
test.describe('Mạch Ảo workstation', () => {
  test('pick a board → workspace with editor + run + wokwi canvas', async ({ page }) => {
    await page.goto('/');

    // start screen → board picker
    await expect(page.getByText('Bắt đầu một dự án mới')).toBeVisible();
    await page.getByTestId('board-arduino-uno').click();

    // workspace: editor pre-filled, Run button present
    const editor = page.getByTestId('editor-code');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(/void setup/);
    await expect(page.getByTestId('ws-run')).toBeVisible();

    // wokwi canvas: add an LED part → a <wokwi-led> custom element renders
    await page.getByTestId('canvas-add-part').click();
    await page.getByTestId('part-led').click();
    await expect(page.locator('wokwi-led').first()).toBeVisible({ timeout: 10_000 });

    // back to the board picker
    await page.getByTestId('ws-back').click();
    await expect(page.getByTestId('board-arduino-uno')).toBeVisible();
  });

  test('templates open the workspace too', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('template-blink').click();
    await expect(page.getByTestId('editor-code')).toBeVisible();
  });
});

test.describe('Mạch Ảo — boards & templates', () => {
  // ESP32-C3 is omitted here: it's flagged work-in-progress and its picker card is disabled.
  for (const b of [
    { id: 'arduino-uno', name: 'Arduino Uno' },
    { id: 'esp32-devkit', name: 'ESP32 (classic)' },
  ]) {
    test(`board ${b.id} → workspace chip "${b.name}"`, async ({ page }) => {
      await page.goto('/');
      await page.getByTestId(`board-${b.id}`).click();
      await expect(page.getByTestId('editor-code')).toBeVisible();
      await expect(page.locator('.boardchip')).toContainText(b.name);
    });
  }

  test('ESP32-C3 is shown as in-development and is NOT selectable', async ({ page }) => {
    await page.goto('/');
    const c3 = page.getByTestId('board-esp32-c3-devkitm');
    await expect(c3).toBeVisible();
    await expect(c3).toBeDisabled(); // the card is disabled while the board is in development
    await expect(c3.getByTestId('board-wip')).toBeVisible(); // shows the "Đang phát triển" badge
    await c3.click({ force: true }).catch(() => {}); // a forced click on a disabled button is a no-op
    await expect(page.getByTestId('editor-code')).toHaveCount(0); // stayed on the Start screen
  });

  for (const t of [
    { id: 'blink', marker: 'Nhấp nháy LED' },
    { id: 'button-led', marker: 'INPUT_PULLUP' },
    { id: 'pot-bright', marker: 'analogWrite' },
    { id: 'temp-lcd', marker: 't=' },
  ]) {
    test(`template ${t.id} loads its distinctive sketch`, async ({ page }) => {
      await page.goto('/');
      await page.getByTestId(`template-${t.id}`).click();
      await expect(page.getByTestId('editor-code')).toHaveValue(
        new RegExp(t.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      await expect(page.locator('.fname')).toContainText(t.id);
    });
  }
});

test.describe('Mạch Ảo — navigation', () => {
  test('?view=labs deep-links straight to Advanced labs', async ({ page }) => {
    await page.goto('/?view=labs');
    await expect(page.getByText('Advanced labs')).toBeVisible();
    await expect(page.getByTestId('tab-capability')).toBeVisible();
    await expect(page.getByText('Bắt đầu một dự án mới')).toHaveCount(0);
  });

  test('start → advanced labs → back to start', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('open-advanced-labs').click();
    await expect(page.getByText('Advanced labs')).toBeVisible();
    await page.getByTestId('labs-back').click();
    await expect(page.getByText('Bắt đầu một dự án mới')).toBeVisible();
  });

  test('workspace → advanced labs → back returns to the workspace (AUD-002)', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    await expect(page.getByTestId('ws-run')).toBeVisible();
    await page.getByTestId('ws-open-labs').click();
    await expect(page.getByText('Advanced labs')).toBeVisible();
    await page.getByTestId('labs-back').click();
    // Back from Labs returns to the project the user was in, not the Start screen.
    await expect(page.getByTestId('ws-run')).toBeVisible();
    await expect(page.getByText('Bắt đầu một dự án mới')).toHaveCount(0);
  });

  test('Start offers Resume after leaving a project, and it reopens the workspace (AUD-002)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    await expect(page.getByTestId('ws-run')).toBeVisible();
    await page.getByTestId('ws-back').click(); // back to Start
    await expect(page.getByText('Bắt đầu một dự án mới')).toBeVisible();
    await page.getByTestId('resume-project').click();
    await expect(page.getByTestId('ws-run')).toBeVisible(); // resumed the same project
  });
});

test.describe('Mạch Ảo — workspace UX + autosave', () => {
  test('idle status pill + serial placeholder before running', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    await expect(page.getByTestId('ws-status')).toContainText('Sẵn sàng');
    await expect(page.getByTestId('serial-log')).toContainText('Bấm Chạy');
    await expect(page.getByTestId('ws-run')).toBeVisible();
    await expect(page.getByTestId('ws-stop')).toHaveCount(0);
  });

  test('edits survive a tab switch AND a full reload (autosave)', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    const editor = page.getByTestId('editor-code');
    await editor.fill('// MARKER-XYZ\nvoid setup(){}\nvoid loop(){}');
    // tab round-trip (editor is hidden on the library tab, value retained on return)
    await page.getByTestId('tab-libs').click();
    await expect(page.getByTestId('editor-code')).toHaveCount(0);
    await page.getByTestId('tab-code').click();
    await expect(editor).toHaveValue(/MARKER-XYZ/);
    // full reload → the autosaved project is restored
    await page.reload();
    await expect(page.getByTestId('editor-code')).toHaveValue(/MARKER-XYZ/, { timeout: 10_000 });
  });

  test('library tab renders + editor has an accessible name', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    await expect(page.getByTestId('editor-code')).toHaveAttribute('aria-label', 'Mã nguồn Arduino');
    await expect(page.getByTestId('ws-back')).toHaveAttribute('aria-label', 'Về trang chủ');
    await page.getByTestId('tab-libs').click();
    await expect(page.getByText('Kéo thả file thư viện')).toBeVisible();
  });
});

// The actual product run path (useSimRunner ↔ WorkspaceShell), which the ?view=labs Sim spec does NOT
// cover. Toolchain-gated like the stage specs.
test.describe('Mạch Ảo — Run (client-side compile)', () => {
  test('Run compiles the blink sketch, streams Serial, then Stop returns to idle', async ({
    page,
  }) => {
    const manifest = await page.request.get('/toolchain/manifest.json');
    test.skip(!manifest.ok(), 'toolchain fixtures absent — run `pnpm toolchain-fixtures`');
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    await page.getByTestId('ws-run').click();
    await expect(page.getByTestId('serial-log')).toContainText('Den', { timeout: 120_000 });
    await expect(page.getByTestId('ws-status')).toContainText('Đang chạy');
    await expect(page.getByTestId('ws-stop')).toBeVisible();
    await page.getByTestId('ws-stop').click();
    await expect(page.getByTestId('ws-status')).toContainText('Sẵn sàng');
    await expect(page.getByTestId('ws-run')).toBeVisible();
  });

  test('a broken sketch shows a friendly compile error and never runs', async ({ page }) => {
    const manifest = await page.request.get('/toolchain/manifest.json');
    test.skip(!manifest.ok(), 'toolchain fixtures absent');
    await page.goto('/');
    await page.getByTestId('board-arduino-uno').click();
    await page.getByTestId('editor-code').fill('void setup(){ int x = 5 }\nvoid loop(){}\n');
    await page.getByTestId('ws-run').click();
    await expect(page.getByTestId('ws-status')).toContainText('thất bại', { timeout: 120_000 });
    await expect(page.getByTestId('ws-message')).toBeVisible();
    await expect(page.getByTestId('ws-stop')).toHaveCount(0); // nothing started
  });
});
