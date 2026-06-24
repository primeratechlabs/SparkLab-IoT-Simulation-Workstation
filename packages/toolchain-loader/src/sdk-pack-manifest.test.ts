/**
 * Guard: the BROWSER-staged ESP32 SDK packs must ship the WiFi/Network headers, so a workspace sketch
 * with `#include <WiFi.h>` compiles client-side (the curriculum networking gate; invariant I8 — no
 * server). The packs themselves are gitignored + regenerated, so this asserts the COMMITTED inputs:
 *   (1) each WiFi manifest actually lists WiFi.h + Network.h, and
 *   (2) the fixture-maker scripts reference the *-wifi-* manifest (not the smaller "blink" subset).
 * Prevents a silent regression back to a no-WiFi pack.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '__fixtures__');
const scripts = join(here, '..', '..', '..', 'scripts');

const WIFI_MANIFESTS = ['c3-wifi-sdk-manifest.txt', 'esp32-classic-wifi-sdk-manifest.txt'];

describe('SDK pack manifest — WiFi headers shipped to the workspace', () => {
  it.each(WIFI_MANIFESTS)('%s lists the WiFi + Network library headers', (name) => {
    const body = readFileSync(join(fixtures, name), 'utf8');
    expect(body).toMatch(/libraries\/WiFi\/src\/WiFi\.h/);
    expect(body).toMatch(/libraries\/Network\/src\/Network\.h/);
  });

  it('the fixture makers stage the WiFi manifest (not the blink subset) into the browser packs', () => {
    const c3 = readFileSync(join(scripts, 'make-c3-fixtures.mjs'), 'utf8');
    const classic = readFileSync(join(scripts, 'make-esp32-classic-fixtures.mjs'), 'utf8');
    // The MANIFEST const must point at the *-wifi-* file (the regex tolerates path/quote variation).
    expect(c3).toMatch(/MANIFEST\s*=[\s\S]*?c3-wifi-sdk-manifest\.txt/);
    expect(classic).toMatch(/MANIFEST\s*=[\s\S]*?esp32-classic-wifi-sdk-manifest\.txt/);
    // And must NOT have reverted to the non-WiFi manifest names as the active MANIFEST.
    expect(c3).not.toMatch(/MANIFEST\s*=[\s\S]*?['"][^'"]*c3-blink-sdk-manifest\.txt/);
  });

  it('the fixture makers bundle the Sparklab helper headers (SparkNet.h, SparkBlynk.h) at spark/', () => {
    for (const f of ['make-c3-fixtures.mjs', 'make-esp32-classic-fixtures.mjs']) {
      const body = readFileSync(join(scripts, f), 'utf8');
      // The makers read SparkNet.h + every SparkBlynk shim and mount them under the `spark/` prefix.
      // The packed path is built DYNAMICALLY (`spark/${file}`), so assert the source refs + the mount
      // prefix rather than a literal `spark/SparkNet.h` join (which a dynamic path never contains).
      expect(body, f).toMatch(/['"]SparkNet\.h['"]/); // reads the SparkNet header
      expect(body, f).toMatch(/SparkBlynk/); // reads the SparkBlynk shim dir
      expect(body, f).toMatch(/`spark\/\$\{file\}`/); // mounts both under the spark/ prefix
    }
    // And the actual headers exist where the makers read them from.
    const fixtures = join(here, '..', '..', 'emulators', 'src', '__fixtures__');
    expect(readFileSync(join(fixtures, 'SparkBlynk', 'SparkBlynk.h'), 'utf8')).toMatch(
      /BLYNK_WRITE/,
    );
    expect(existsSync(join(fixtures, 'SparkNet', 'SparkNet.h'))).toBe(true);
  });
});
