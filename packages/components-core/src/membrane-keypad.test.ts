import { describe, it, expect } from 'vitest';
import { MembraneKeypad } from './membrane-keypad.js';
import { MockCircuitHost } from './mock-host.js';

// rows R1..R4 = pins 2..5, cols C1..C4 = pins 6..9.
const ROWS = [2, 3, 4, 5];
const COLS = [6, 7, 8, 9];

describe('MembraneKeypad (4×4 matrix)', () => {
  it('bridges the held key’s column to LOW only while its row is scanned LOW', () => {
    const kp = new MembraneKeypad('k', ROWS, COLS);
    const host = new MockCircuitHost();
    kp.attach(host);
    ROWS.forEach((r) => host.mcuWrite(r, 'high')); // idle scan: all rows HIGH
    kp.setKey('5'); // index 4 → row 1 (pin 3), col 1 (pin 7)

    // no row driven LOW yet → every column floats (MCU pull-up reads HIGH)
    expect(host.driven.get(7)).toBe('high-z');

    host.mcuWrite(3, 'low'); // firmware strobes row R2 LOW
    expect(host.driven.get(7)).toBe('low'); // key 5's column C2 is pulled LOW
    expect(host.driven.get(6)).toBe('high-z'); // other columns stay floating
    expect(host.driven.get(8)).toBe('high-z');
  });

  it('does not bridge a column when a DIFFERENT row is scanned', () => {
    const kp = new MembraneKeypad('k', ROWS, COLS);
    const host = new MockCircuitHost();
    kp.attach(host);
    ROWS.forEach((r) => host.mcuWrite(r, 'high'));
    kp.setKey('5'); // row 1
    host.mcuWrite(2, 'low'); // strobe row R1 (not key 5's row)
    expect(host.driven.get(7)).toBe('high-z'); // C2 not pulled → no false key
  });

  it('releases all columns when the key is let go', () => {
    const kp = new MembraneKeypad('k', ROWS, COLS);
    const host = new MockCircuitHost();
    kp.attach(host);
    ROWS.forEach((r) => host.mcuWrite(r, 'high'));
    kp.setKey('5');
    host.mcuWrite(3, 'low');
    expect(host.driven.get(7)).toBe('low');
    kp.setKey(''); // release
    expect(host.driven.get(7)).toBe('high-z');
    expect(kp.keyLabel).toBe('');
  });
});
