import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { Led } from './led.js';

/** Drive `periods` PWM cycles of highUs HIGH + lowUs LOW on `pin` (virtual time). */
function drivePwm(
  host: MockCircuitHost,
  pin: number,
  highUs: number,
  lowUs: number,
  periods: number,
): void {
  for (let i = 0; i < periods; i++) {
    host.mcuWrite(pin, 'high');
    host.advance(highUs * 1000);
    host.mcuWrite(pin, 'low');
    host.advance(lowUs * 1000);
  }
  host.mcuWrite(pin, 'high'); // one more edge so the last LOW segment is accounted, then settle
  host.mcuWrite(pin, 'low');
}

describe('Led — on/off + PWM brightness (CMB-04)', () => {
  it('reflects steady HIGH as fully on, steady LOW as off', () => {
    const host = new MockCircuitHost();
    const led = new Led('led1', 9);
    led.attach(host);
    expect(led.on).toBe(false);
    expect(led.brightness).toBe(0);

    host.mcuWrite(9, 'high');
    host.advance(5_000_000);
    led.tick(); // steady segment is accounted on the per-instruction refresh
    expect(led.on).toBe(true);
    expect(led.brightness).toBeCloseTo(1, 2);
    expect(led.toggles).toBe(1);
  });

  it('measures ~50% PWM duty as half brightness (analogWrite fade, not binary)', () => {
    const host = new MockCircuitHost();
    const led = new Led('led1', 9);
    led.attach(host);
    drivePwm(host, 9, 1000, 1000, 20); // 1ms HIGH + 1ms LOW × 20 (490Hz-ish)
    expect(led.brightness).toBeGreaterThan(0.4);
    expect(led.brightness).toBeLessThan(0.6);
  });

  it('measures ~25% PWM duty distinctly from ~75%', () => {
    const dimHost = new MockCircuitHost();
    const dim = new Led('dim', 9);
    dim.attach(dimHost);
    drivePwm(dimHost, 9, 500, 1500, 20); // 25%

    const brightHost = new MockCircuitHost();
    const bright = new Led('bright', 9);
    bright.attach(brightHost);
    drivePwm(brightHost, 9, 1500, 500, 20); // 75%

    expect(dim.brightness).toBeLessThan(0.35);
    expect(bright.brightness).toBeGreaterThan(0.65);
    expect(bright.brightness).toBeGreaterThan(dim.brightness);
  });
});
