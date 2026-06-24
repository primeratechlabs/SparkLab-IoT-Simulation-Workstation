import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { DipSwitch } from './dip-switch.js';

const PINS = [2, 3, 4, 5, 6, 7, 8, 9];

describe('DipSwitch', () => {
  it('open switches release the line (high-z → pull-up HIGH); closed ties it LOW', () => {
    const host = new MockCircuitHost();
    const dip = new DipSwitch('dip', PINS);
    dip.attach(host);
    for (const p of PINS) expect(host.driven.get(p)).toBe('high-z'); // all OFF at rest

    dip.set(2, true); // close switch index 2
    expect(host.driven.get(PINS[2]!)).toBe('low');
    expect(host.driven.get(PINS[3]!)).toBe('high-z'); // others unchanged
    expect(dip.on[2]).toBe(true);

    dip.set(2, false);
    expect(host.driven.get(PINS[2]!)).toBe('high-z');
    expect(dip.on[2]).toBe(false);
  });

  it('honours the initial ON pattern at construction', () => {
    const host = new MockCircuitHost();
    const dip = new DipSwitch('dip', PINS, { on: [true, false, true] });
    dip.attach(host);
    expect(host.driven.get(PINS[0]!)).toBe('low');
    expect(host.driven.get(PINS[1]!)).toBe('high-z');
    expect(host.driven.get(PINS[2]!)).toBe('low');
  });

  it('ignores out-of-range switch indices (no throw, no stray drive)', () => {
    const host = new MockCircuitHost();
    const dip = new DipSwitch('dip', PINS);
    dip.attach(host);
    expect(() => dip.set(99, true)).not.toThrow();
    expect(() => dip.set(-1, true)).not.toThrow();
    expect(dip.on.every((x) => x === false)).toBe(true);
  });
});
