import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { Buzzer } from './buzzer.js';

/**
 * Drive a square wave on `pin`: toggle the level every `halfPeriodNs`, advancing
 * virtual time so the buzzer captures real edge timestamps via host.now(). Returns
 * after `cycles` full periods. Leaves the pin at its last toggled level.
 */
function driveSquareWave(host: MockCircuitHost, pin: number, freqHz: number, cycles: number): void {
  const halfPeriodNs = Math.round(1e9 / freqHz / 2);
  let level: 'low' | 'high' = 'low';
  for (let i = 0; i < cycles * 2; i++) {
    level = level === 'low' ? 'high' : 'low';
    host.mcuWrite(pin, level);
    host.advance(halfPeriodNs);
  }
}

describe('Buzzer', () => {
  it('estimates ~1kHz from a 500µs-half-period square wave (±10%)', () => {
    const host = new MockCircuitHost();
    const buzzer = new Buzzer('buzz', 9);
    buzzer.attach(host);

    driveSquareWave(host, 9, 1000, 10); // 1kHz for 10 periods

    expect(buzzer.playing).toBe(true);
    expect(buzzer.frequencyHz).toBeGreaterThan(900);
    expect(buzzer.frequencyHz).toBeLessThan(1100);
    expect(buzzer.frequencyHz).toBeCloseTo(1000, -1);
  });

  it('reads silent before any edge arrives', () => {
    const host = new MockCircuitHost();
    const buzzer = new Buzzer('buzz', 9);
    buzzer.attach(host);

    expect(buzzer.playing).toBe(false);
    expect(buzzer.frequencyHz).toBe(0);
    expect(buzzer.edges).toBe(0);
  });

  it('needs two edges before it can report a frequency', () => {
    const host = new MockCircuitHost();
    const buzzer = new Buzzer('buzz', 9);
    buzzer.attach(host);

    // A single edge gives no period yet — still silent.
    host.mcuWrite(9, 'high');
    expect(buzzer.edges).toBe(1);
    expect(buzzer.playing).toBe(false);
    expect(buzzer.frequencyHz).toBe(0);

    // Second edge 500µs later closes a half period → ~1kHz.
    host.advance(500_000);
    host.mcuWrite(9, 'low');
    expect(buzzer.edges).toBe(2);
    expect(buzzer.playing).toBe(true);
    expect(buzzer.frequencyHz).toBeCloseTo(1000, -1);
  });

  it('ignores writes of the same level (only real edges count)', () => {
    const host = new MockCircuitHost();
    const buzzer = new Buzzer('buzz', 9);
    buzzer.attach(host);

    host.mcuWrite(9, 'high');
    host.advance(500_000);
    host.mcuWrite(9, 'high'); // repeat HIGH — not an edge
    host.advance(500_000);
    host.mcuWrite(9, 'high'); // still HIGH — not an edge
    expect(buzzer.edges).toBe(1);
    expect(buzzer.playing).toBe(false);

    host.mcuWrite(9, 'low'); // now a real falling edge, 1ms after the rise
    expect(buzzer.edges).toBe(2);
    expect(buzzer.frequencyHz).toBeCloseTo(500, -1); // 1ms half period → 500Hz
  });

  it('goes silent once edges stop arriving (noTone / steady level)', () => {
    const host = new MockCircuitHost();
    const buzzer = new Buzzer('buzz', 9, 2_000_000); // 2ms stale window
    buzzer.attach(host);

    driveSquareWave(host, 9, 1000, 5);
    expect(buzzer.playing).toBe(true);

    // No more edges: after the stale window elapses the tone is over.
    host.advance(3_000_000); // 3ms > 2ms window
    expect(buzzer.playing).toBe(false);
    expect(buzzer.frequencyHz).toBe(0);
  });

  it('tracks a frequency change between two tones', () => {
    const host = new MockCircuitHost();
    const buzzer = new Buzzer('buzz', 9);
    buzzer.attach(host);

    driveSquareWave(host, 9, 1000, 5);
    expect(buzzer.frequencyHz).toBeCloseTo(1000, -1);

    driveSquareWave(host, 9, 2000, 5); // switch to 2kHz
    expect(buzzer.frequencyHz).toBeGreaterThan(1800);
    expect(buzzer.frequencyHz).toBeLessThan(2200);
  });

  it('handles a low audio tone (440Hz / A4) within tolerance', () => {
    const host = new MockCircuitHost();
    const buzzer = new Buzzer('buzz', 9);
    buzzer.attach(host);

    driveSquareWave(host, 9, 440, 8);
    expect(buzzer.playing).toBe(true);
    expect(buzzer.frequencyHz).toBeGreaterThan(440 * 0.9);
    expect(buzzer.frequencyHz).toBeLessThan(440 * 1.1);
  });

  it('seeds its initial level from the pin so a first opposite write is a real edge', () => {
    const host = new MockCircuitHost();
    host.mcuWrite(9, 'high'); // pin already HIGH before attach
    const buzzer = new Buzzer('buzz', 9);
    buzzer.attach(host);

    // Re-writing HIGH must not count as an edge (matches the seeded level)...
    host.mcuWrite(9, 'high');
    expect(buzzer.edges).toBe(0);
    // ...but a transition to LOW does.
    host.advance(500_000);
    host.mcuWrite(9, 'low');
    expect(buzzer.edges).toBe(1);
  });
});
