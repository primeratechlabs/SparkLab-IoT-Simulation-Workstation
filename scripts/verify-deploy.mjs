#!/usr/bin/env node
/**
 * Post-deploy verification against a LIVE url — the only reliable check for hosts that strip/override
 * COOP/COEP. Asserts header correctness, toolchain integrity (manifest is real JSON, not an SPA HTML
 * fallback masking a missing toolchain), and — if Playwright is available — real-Chromium
 * crossOriginIsolated + SharedArrayBuffer.
 *
 *   node scripts/verify-deploy.mjs https://your-deploy-url
 */
import { coiHeaders, cspDirectives } from '../packages/app/headers.config.mjs';

/* global fetch */

const BASE = (process.argv[2] || process.env.BASE_URL || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('usage: node scripts/verify-deploy.mjs <BASE_URL>');
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log('  ✓', m);
const bad = (m) => {
  console.error('  ✗', m);
  failures++;
};

console.log(`Verifying ${BASE}\n`);

// 1. cross-origin isolation + CSP headers on the index
const root = await fetch(BASE + '/', { redirect: 'manual' }).catch((e) => {
  bad(`cannot reach ${BASE}: ${e.message}`);
  return null;
});
if (root) {
  for (const [k, v] of Object.entries(coiHeaders)) {
    const got = root.headers.get(k);
    if (got === v) ok(`${k}: ${v}`);
    else bad(`${k}: expected "${v}", got "${got ?? '(absent)'}"`);
  }
  const csp = root.headers.get('content-security-policy') || '';
  for (const d of cspDirectives) {
    if (csp.includes(d)) ok(`CSP has: ${d}`);
    else bad(`CSP missing: ${d}`);
  }
  if (csp.includes("'unsafe-eval'")) bad("CSP contains 'unsafe-eval'");
}

// 2. toolchain integrity — each shipped board's pack manifest must be JSON (not the SPA HTML fallback)
// AND carry CORP (a /esp32-classic-toolchain/ that falls through to `location /` would be no-cache +
// SPA-masked). Checks the AVR /toolchain/ + the selectable ESP32-classic pack.
for (const [path, label] of [
  ['/toolchain/manifest.json', 'toolchain/manifest.json (AVR)'],
  ['/esp32-classic-toolchain/esp32-classic-sdk.json', 'esp32-classic-toolchain/esp32-classic-sdk.json (ESP32)'],
]) {
  const r = await fetch(BASE + path).catch(() => null);
  const ct = r?.headers.get('content-type') || '';
  const corp = r?.headers.get('cross-origin-resource-policy');
  if (!r?.ok || !ct.includes('json'))
    bad(`${label} not real JSON (status ${r?.status ?? '?'}, type "${ct}") — SPA fallback masking a missing toolchain?`);
  else if (corp !== 'same-origin')
    bad(`${label} is JSON but missing CORP (got "${corp ?? '(absent)'}") — needs a dedicated location block, else COEP can break it`);
  else ok(`${label} is JSON 200 + CORP`);
}

// 2b. /assets CORP probe — the index page can be isolated while a regex static-file block (aaPanel adds
// one) strips Cross-Origin-Resource-Policy from hashed assets/fonts, which COEP then BLOCKS. The old
// verifier never probed an asset, so it went green while fonts were de-isolated. Probe a real woff2/js.
const { readdirSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
let assetPath = null;
try {
  const distAssets = fileURLToPath(new URL('../packages/app/dist/assets/', import.meta.url));
  const names = readdirSync(distAssets);
  const pick = names.find((n) => n.endsWith('.woff2')) || names.find((n) => n.endsWith('.js'));
  if (pick) assetPath = '/assets/' + pick;
} catch {
  /* dist not local — fall back to parsing the served index for a hashed asset */
}
if (!assetPath && root) {
  const html = await root
    .clone()
    .text()
    .catch(() => '');
  const m = html.match(/\/assets\/[A-Za-z0-9._-]+\.(?:woff2|js|css)/);
  if (m) assetPath = m[0];
}
if (assetPath) {
  const asset = await fetch(BASE + assetPath).catch(() => null);
  const corp = asset?.headers.get('cross-origin-resource-policy');
  if (asset?.ok && corp === 'same-origin')
    ok(`asset ${assetPath} carries Cross-Origin-Resource-Policy: same-origin`);
  else
    bad(
      `asset ${assetPath} missing CORP (got "${corp ?? '(absent)'}", status ${asset?.status ?? '?'}) — a regex static block is de-isolating /assets/; COEP will block it. Use ^~ /assets/ or remove aaPanel's static block.`,
    );
} else {
  console.log('  · (assets CORP probe skipped — no hashed asset found locally or in index)');
}

// 3. optional real-browser cross-origin isolation
try {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const isolated = await page.evaluate(
    () =>
      globalThis.crossOriginIsolated === true && typeof globalThis.SharedArrayBuffer === 'function',
  );
  if (isolated) ok('crossOriginIsolated + SharedArrayBuffer available in Chromium');
  else bad('NOT cross-origin isolated in the browser — SharedArrayBuffer unavailable');
  await browser.close();
} catch (e) {
  console.log(`  · (browser crossOriginIsolated check skipped — ${e.message})`);
}

console.log(failures === 0 ? '\n✓ deploy verified' : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
