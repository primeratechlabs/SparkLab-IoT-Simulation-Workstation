import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIntelHex } from './intel-hex.js';
import { AVRRunner } from './avr-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const HEX_PATH = join(here, '..', 'test-fixtures', 'blink-uno.hex');

describe('Blink firmware on avr8js (real avr-gcc output)', () => {
  it('toggles D13/PB5 at ~1 Hz and prints to Serial (virtual-time)', () => {
    const hex = readFileSync(HEX_PATH, 'utf8');
    const { bytes } = parseIntelHex(hex);
    const runner = new AVRRunner(bytes);

    // Capture exact PB5 transition times via the GPIO listener (I3 virtual time).
    const toggleTimesMs: number[] = [];
    let lastBit5 = 0;
    runner.addGpioListener('B', (value) => {
      const bit5 = (value >> 5) & 1;
      if (bit5 !== lastBit5) {
        lastBit5 = bit5;
        toggleTimesMs.push(runner.virtualTimeNs / 1e6);
      }
    });

    let serial = '';
    runner.onSerialByte((b) => (serial += String.fromCharCode(b)));

    // Run ~2.3s of virtual time → expect HIGH→LOW→HIGH (≥2 transitions after start).
    runner.executeForMillis(2300);

    expect(toggleTimesMs.length).toBeGreaterThanOrEqual(2);
    // Period between consecutive transitions ≈ 1000 ms (delay(1000)).
    const period = toggleTimesMs[1]! - toggleTimesMs[0]!;
    expect(period).toBeGreaterThan(900);
    expect(period).toBeLessThan(1100);

    expect(serial).toContain('blink on');
    expect(serial).toContain('blink off');
  }, 30_000);
});
