import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { Ldr } from './ldr.js';

describe('Ldr', () => {
  it('sets an ADC voltage on the channel as soon as it attaches', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 0);
    expect(host.adc.has(0)).toBe(false);
    ldr.attach(host);
    expect(host.adc.has(0)).toBe(true);
    expect(host.adc.get(0)).toBe(ldr.volts);
  });

  it('reads LOW in the dark and HIGH in bright light', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 0);
    ldr.attach(host);

    ldr.setLux(1); // dark → high LDR resistance → wiper pulled toward GND
    const dark = host.adc.get(0)!;
    expect(dark).toBeLessThan(1); // well under 5V/2

    ldr.setLux(10_000); // bright → low LDR resistance → wiper pulled toward VCC
    const bright = host.adc.get(0)!;
    expect(bright).toBeGreaterThan(4);

    expect(bright).toBeGreaterThan(dark);
  });

  it('sits near the divider midpoint at the 10-lux reference (Rldr == Rfixed)', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 0);
    ldr.attach(host);
    ldr.setLux(10); // Rldr == R10 == Rfixed == 10kΩ → VCC/2
    expect(host.adc.get(0)).toBeCloseTo(2.5, 2);
  });

  it('is strictly monotonic increasing in lux across a wide sweep', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 0);
    ldr.attach(host);

    const lux = [0.5, 1, 5, 10, 50, 100, 500, 1000, 5000, 20_000, 80_000];
    let prev = -Infinity;
    for (const l of lux) {
      ldr.setLux(l);
      const v = host.adc.get(0)!;
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('keeps the wiper voltage within (0, VCC) for every illuminance', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 0, { vcc: 5 });
    ldr.attach(host);
    for (const l of [0.1, 1, 100, 10_000, 100_000]) {
      ldr.setLux(l);
      const v = host.adc.get(0)!;
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(5);
    }
  });

  it('clamps lux to [0.1, 100000] at both extremes', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 0);
    ldr.attach(host);

    ldr.setLux(0.1);
    const minClamped = host.adc.get(0)!;
    ldr.setLux(0.0001); // below the floor → same as 0.1
    expect(host.adc.get(0)).toBeCloseTo(minClamped, 9);

    ldr.setLux(100_000);
    const maxClamped = host.adc.get(0)!;
    ldr.setLux(1e9); // above the ceiling → same as 100000
    expect(host.adc.get(0)).toBeCloseTo(maxClamped, 9);
  });

  it('tolerates non-finite / negative lux without producing NaN', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 0);
    ldr.attach(host);

    ldr.setLux(-100); // negative → clamped up to the 0.1 floor (darkest)
    const dark = host.adc.get(0)!;
    expect(Number.isFinite(dark)).toBe(true);
    ldr.setLux(0.1);
    expect(host.adc.get(0)).toBeCloseTo(dark, 9);
  });

  it('scales the wiper voltage with a custom VCC', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 0, { vcc: 3.3 });
    ldr.attach(host);
    ldr.setLux(10); // midpoint of the divider → VCC/2
    expect(host.adc.get(0)).toBeCloseTo(1.65, 2);
  });

  it('shifts the curve when Rfixed changes (larger Rfixed → higher wiper)', () => {
    const small = new Ldr('a', 0, { rFixedOhms: 1_000 });
    const large = new Ldr('b', 1, { rFixedOhms: 100_000 });
    const host = new MockCircuitHost();
    small.attach(host);
    large.attach(host);
    small.setLux(100);
    large.setLux(100);
    expect(host.adc.get(1)!).toBeGreaterThan(host.adc.get(0)!);
  });

  it('exposes a raw 10-bit ADC reading consistent with the wiper voltage', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 0);
    ldr.attach(host);
    ldr.setLux(10); // VCC/2 → ~half of full-scale 1023
    expect(ldr.adc).toBeGreaterThan(500);
    expect(ldr.adc).toBeLessThan(523);
    expect(ldr.adc).toBeGreaterThanOrEqual(0);
    expect(ldr.adc).toBeLessThanOrEqual(1023);
  });

  it('writes only to its own ADC channel', () => {
    const host = new MockCircuitHost();
    const ldr = new Ldr('ldr', 3);
    ldr.attach(host);
    ldr.setLux(500);
    expect(host.adc.has(3)).toBe(true);
    expect(host.adc.has(0)).toBe(false);
  });
});
