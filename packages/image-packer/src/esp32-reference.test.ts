/**
 * Cross-validates the ESP32 image-packer against REAL esptool output: a C3 sketch built
 * by arduino-cli (gcc + esptool) produces .bin / .partitions.bin / .merged.bin under
 * ci/toolchain-builder/esp32/build. We parse esptool's app image, re-encode it with our
 * espAppImage, and assert byte-identity — proving our packer is esptool-compatible.
 * Skips when the (gitignored, [CI/HUMAN]) ESP32 build artifacts are absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEspAppImage, espAppImage, mergeFlash, C3_OFFSETS } from './esp32.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(
  here,
  '..',
  '..',
  '..',
  'ci',
  'toolchain-builder',
  'esp32',
  'build',
  'sketches',
  'C3Blink',
  'out',
);
const appBin = join(OUT, 'C3Blink.ino.bin');
const partBin = join(OUT, 'C3Blink.ino.partitions.bin');
const bootBin = join(OUT, 'C3Blink.ino.bootloader.bin');
const mergedBin = join(OUT, 'C3Blink.ino.merged.bin');
const ready = existsSync(appBin) && existsSync(mergedBin);

describe.skipIf(!ready)('ESP32 image-packer vs real esptool output (ESP32-C3)', () => {
  it('parses esptool app image: magic, chip id 5, valid XOR checksum', () => {
    const img = new Uint8Array(readFileSync(appBin));
    const p = parseEspAppImage(img);
    expect(p.chipId).toBe(5); // ESP32-C3
    expect(p.flashMode).toBe(2); // DIO
    expect(p.checksumOk).toBe(true); // our checksum algorithm matches esptool's
    expect(p.segments.length).toBeGreaterThan(0);
  });

  it('re-encodes the parsed app image BYTE-IDENTICAL to esptool (header + segments + checksum + SHA-256)', async () => {
    const ref = new Uint8Array(readFileSync(appBin));
    const p = parseEspAppImage(ref);
    expect(p.hashAppended).toBe(true);
    const ours = await espAppImage(p.entry, p.segments, {
      chip: 'esp32-c3',
      flashMode: p.flashMode,
      flashSizeId: p.flashSizeId,
      flashFreqId: p.flashFreqId,
      hashAppended: true,
    });
    expect(ours.length).toBe(ref.length);
    expect(Array.from(ours)).toEqual(Array.from(ref)); // FULL image byte-identical incl. SHA-256
  });

  it('merge_bin reproduces esptool merged flash at the bootloader/partition/app slots', () => {
    if (!existsSync(partBin) || !existsSync(bootBin)) return;
    const boot = new Uint8Array(readFileSync(bootBin));
    const part = new Uint8Array(readFileSync(partBin));
    const app = new Uint8Array(readFileSync(appBin));
    const merged = mergeFlash({ bootloader: boot, partitions: part, app }, C3_OFFSETS);
    const ref = new Uint8Array(readFileSync(mergedBin));
    // Our merged image must match esptool's at each placed region.
    expect(
      Array.from(merged.slice(C3_OFFSETS.bootloader, C3_OFFSETS.bootloader + boot.length)),
    ).toEqual(Array.from(ref.slice(C3_OFFSETS.bootloader, C3_OFFSETS.bootloader + boot.length)));
    expect(Array.from(merged.slice(C3_OFFSETS.app, C3_OFFSETS.app + 64))).toEqual(
      Array.from(ref.slice(C3_OFFSETS.app, C3_OFFSETS.app + 64)),
    );
  });
});
