/**
 * End-to-end pin check for AUD-013: the integrity.json shipped by the fixture scripts must pin the EXACT
 * bytes the loader will fetch. This catches the classic mismatch between how the script hashes (Node
 * createHash over a JS string / file) and how the loader hashes (Web Crypto sha256Hex over the fetched
 * bytes) — an encoding drift here would make every production build fail-closed spuriously. Gated on the
 * (gitignored) regenerated packs being present.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sha256Hex, type IntegrityManifest } from './asset-integrity.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', '..', 'public');
// (toolchain dir, the JSON pack asset to spot-check — the .mjs are huge, so verify the SDK pack pin which is
// the same string→bytes path that is most likely to drift on encoding).
const PACKS: [string, string][] = [
  ['c3-toolchain', 'c3-sdk.json'],
  ['esp32-classic-toolchain', 'esp32-classic-sdk.json'],
  ['toolchain', 'sdk.json'],
];

for (const [dir, asset] of PACKS) {
  const manifestPath = join(PUBLIC, dir, 'integrity.json');
  const assetPath = join(PUBLIC, dir, asset);
  const ready = existsSync(manifestPath) && existsSync(assetPath);
  describe.skipIf(!ready)(`asset-integrity pack pin — ${dir}`, () => {
    const manifest = ready
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as IntegrityManifest)
      : {};
    it('integrity.json pins are 64-hex and cover the SDK pack', () => {
      for (const [name, pin] of Object.entries(manifest)) {
        expect(pin, `${name} pin`).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(manifest[asset], `${asset} must be pinned`).toBeDefined();
    });
    it(`the shipped ${asset} hashes to its pin (script hash == loader hash, no encoding drift)`, async () => {
      const bytes = new Uint8Array(readFileSync(assetPath));
      expect(await sha256Hex(bytes)).toBe(manifest[asset]);
    });
  });
}
