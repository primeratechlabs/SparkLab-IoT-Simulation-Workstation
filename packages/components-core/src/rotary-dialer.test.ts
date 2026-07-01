import { describe, it, expect } from 'vitest';
import { RotaryDialer } from './rotary-dialer.js';
import { MockCircuitHost } from './mock-host.js';

const PULSE = 14;
const DIAL = 15;

/** Dial `digit`, run the virtual clock past the pulse train, and count the LOW pulses emitted on PULSE. */
function dialAndCount(digit: number): { lows: number; dialLevels: string[] } {
  const d = new RotaryDialer('d', PULSE, DIAL);
  const host = new MockCircuitHost();
  d.attach(host);
  const pulseEvents: string[] = [];
  const dialLevels: string[] = [];
  const orig = host.drivePin.bind(host);
  host.drivePin = (pin, lvl) => {
    if (pin === PULSE) pulseEvents.push(lvl);
    if (pin === DIAL) dialLevels.push(lvl);
    return orig(pin, lvl);
  };
  d.dial(digit);
  for (let i = 0; i < 30; i++) host.advance(50_000_000); // 1.5s — well past 10 × 100ms pulses
  return { lows: pulseEvents.filter((e) => e === 'low').length, dialLevels };
}

describe('RotaryDialer (pulse dialing)', () => {
  it('emits N LOW pulses for digit N', () => {
    expect(dialAndCount(3).lows).toBe(3);
    expect(dialAndCount(7).lows).toBe(7);
    expect(dialAndCount(1).lows).toBe(1);
  });

  it('emits ten pulses for digit 0', () => {
    expect(dialAndCount(0).lows).toBe(10);
  });

  it('closes the DIAL contact during the dial and releases it after', () => {
    const { dialLevels } = dialAndCount(2);
    expect(dialLevels[0]).toBe('low'); // off-normal contact closes at the start
    expect(dialLevels[dialLevels.length - 1]).toBe('high-z'); // and opens when finished
  });

  it('records the last dialled digit', () => {
    const d = new RotaryDialer('d', PULSE);
    const host = new MockCircuitHost();
    d.attach(host);
    d.dial(9);
    expect(d.lastDigit).toBe(9);
  });
});
