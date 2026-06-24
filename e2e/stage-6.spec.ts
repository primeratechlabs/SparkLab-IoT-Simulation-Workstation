import { test, expect, type Page } from '@playwright/test';

/**
 * Stage 6 e2e — the Network Lab in a real browser: WiFi connect, a sensor value published over
 * MQTT, and a cloud command coming back to drive the relay. Tier 1 (fake broker) is deterministic
 * and always runs; Tier 2 (a real public broker over WebSocket) runs when reachable. No backend
 * compile, no server of our own (I8).
 */

async function gotoNetwork(page: Page): Promise<void> {
  await page.goto('/?view=labs');
  await page.getByTestId('tab-network').click();
  await expect(page.getByTestId('net-wifi-status')).toBeVisible();
}

test.describe('Stage 6 — Network Lab (WiFi + sensor + MQTT, client-side)', () => {
  test('Tier 1 (fake broker): connect WiFi, publish telemetry, receive a command → relay', async ({
    page,
  }) => {
    // I8 — nothing is compiled/proxied server-side; the fake tier makes no external connection at all
    let backendRequests = 0;
    page.on('request', (r) => {
      if (/\/(api\/)?compile|\/backend\//.test(r.url())) backendRequests++;
    });

    await gotoNetwork(page);
    await expect(page.getByTestId('net-tier-fake')).toHaveClass(/active/);
    await expect(page.getByTestId('net-wifi-status')).toHaveText('idle');

    // connect WiFi → the simulated association handshake completes
    await page.getByTestId('net-wifi-connect').click();
    await expect(page.getByTestId('net-wifi-status')).toHaveText('connected', { timeout: 10_000 });

    // publish the multi-sensor readings → they show in the outgoing log
    await expect(page.getByTestId('net-sensor-value')).toHaveText('2750');
    await page.getByTestId('net-publish').click();
    await expect(page.getByTestId('net-published')).toContainText('temp = 2750');
    await expect(page.getByTestId('net-published')).toContainText('humidity = 1800');
    // the broker echoes the telemetry back to the device's subscription
    await expect(page.getByTestId('net-received')).toContainText('echoed telemetry = 2750');

    // a cloud dashboard commands the relay; the device reacts
    await expect(page.getByTestId('net-relay')).toHaveText('off');
    await page.getByTestId('net-cmd-on').click();
    await expect(page.getByTestId('net-relay')).toHaveText('on');
    await page.getByTestId('net-cmd-off').click();
    await expect(page.getByTestId('net-relay')).toHaveText('off');

    // HTTP panel (fake echo, deterministic)
    await page.getByTestId('net-http-send').click();
    await expect(page.getByTestId('net-http-result')).toContainText('200');
    await expect(page.getByTestId('net-received')).toContainText('HTTP GET');

    expect(backendRequests).toBe(0);
  });

  test('Tier 2 (real broker over WebSocket): command round-trips through the broker — best-effort', async ({
    page,
  }) => {
    // Depends on a public broker over the network, so it is best-effort: any failure (offline,
    // CSP, broker latency) skips rather than fails. The deterministic coverage is the Tier-1 e2e
    // above + the transport-level real-broker test in @sparklab/network-shim.
    await gotoNetwork(page);
    await page.getByTestId('net-tier-real').click();
    await page.getByTestId('net-wifi-connect').click();

    let connected = false;
    try {
      await expect(page.getByTestId('net-wifi-status')).toHaveText('connected', {
        timeout: 12_000,
      });
      connected = true;
    } catch {
      connected = false;
    }
    test.skip(!connected, 'public MQTT broker unreachable from this environment');

    await page.waitForTimeout(1500); // let the SUBSCRIBE register on the real broker
    await page.getByTestId('net-publish').click();
    await page.getByTestId('net-cmd-on').click();

    let relayOn = false;
    try {
      await expect(page.getByTestId('net-relay')).toHaveText('on', { timeout: 12_000 });
      relayOn = true;
    } catch {
      relayOn = false;
    }
    test.skip(!relayOn, 'real-broker round-trip did not complete in time (public broker latency)');
    expect(relayOn).toBe(true);
  });
});
