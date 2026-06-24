import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { Ntc } from './ntc.js';

describe('Ntc', () => {
  it('reads ≈ half VCC at 25°C (NTC ≈ R0 = Rfixed → balanced divider)', () => {
    const host = new MockCircuitHost();
    const ntc = new Ntc('ntc', 0); // defaults: R0 = Rfixed = 10kΩ
    ntc.attach(host);
    ntc.setTempC(25);
    // Balanced divider → wiper sits at VCC/2 = 2.5V.
    expect(host.adc.get(0)).toBeCloseTo(2.5, 3);
    expect(ntc.volts).toBeCloseTo(2.5, 3);
  });

  it('drops below half VCC when hotter than 25°C (lower R ⇒ lower volts)', () => {
    const host = new MockCircuitHost();
    const ntc = new Ntc('ntc', 0);
    ntc.attach(host);
    ntc.setTempC(25);
    const at25 = ntc.volts;
    ntc.setTempC(50);
    expect(ntc.volts).toBeLessThan(at25);
    expect(ntc.volts).toBeLessThan(2.5);
  });

  it('rises above half VCC when colder than 25°C (higher R ⇒ higher volts)', () => {
    const host = new MockCircuitHost();
    const ntc = new Ntc('ntc', 0);
    ntc.attach(host);
    ntc.setTempC(0);
    expect(ntc.volts).toBeGreaterThan(2.5);
    expect(ntc.volts).toBeLessThan(5); // never reaches the rail
  });

  it('is strictly monotonic decreasing in temperature', () => {
    const host = new MockCircuitHost();
    const ntc = new Ntc('ntc', 0);
    ntc.attach(host);
    const temps = [-20, -10, 0, 10, 20, 25, 30, 40, 60, 80, 100];
    const volts: number[] = [];
    for (const t of temps) {
      ntc.setTempC(t);
      volts.push(ntc.volts);
    }
    for (let i = 1; i < volts.length; i++) {
      expect(volts[i]!).toBeLessThan(volts[i - 1]!);
    }
  });

  it('keeps the wiper strictly inside the rails across an extreme span', () => {
    const host = new MockCircuitHost();
    const ntc = new Ntc('ntc', 0);
    ntc.attach(host);
    for (const t of [-40, 0, 25, 85, 150]) {
      ntc.setTempC(t);
      expect(ntc.volts).toBeGreaterThan(0);
      expect(ntc.volts).toBeLessThan(5);
    }
  });

  it('publishes the wiper voltage to the configured ADC channel on attach', () => {
    const host = new MockCircuitHost();
    const ntc = new Ntc('ntc', 3); // channel A3
    ntc.attach(host);
    // attach() seeds the default 25°C reading on the right channel only.
    expect(host.adc.get(3)).toBeCloseTo(2.5, 3);
    expect(host.adc.has(0)).toBe(false);
  });

  it('exposes a correct raw ADC reading (10-bit, VCC ref)', () => {
    const host = new MockCircuitHost();
    const ntc = new Ntc('ntc', 0);
    ntc.attach(host);
    ntc.setTempC(25);
    // 2.5V / 5V * 1023 ≈ 512.
    expect(ntc.adcRaw).toBe(Math.round((2.5 / 5) * 1023));
  });

  it('honours custom vcc / rFixedOhms / beta / r0 options', () => {
    const host = new MockCircuitHost();
    // 3.3V rail, 4.7kΩ fixed, β=3435, R0=10kΩ.
    const ntc = new Ntc('ntc', 0, { vcc: 3.3, rFixedOhms: 4700, beta: 3435, r0: 10_000 });
    ntc.attach(host);
    ntc.setTempC(25);
    // At 25°C the NTC = R0 = 10kΩ; divider top = 4.7kΩ.
    // V_w = vcc * Rntc / (Rfixed + Rntc) = 3.3 * 10000 / 14700.
    const expected = (3.3 * 10_000) / 14_700;
    expect(ntc.volts).toBeCloseTo(expected, 3);
    expect(host.adc.get(0)).toBeCloseTo(expected, 3);
  });

  it('matches the Beta equation: at T = T0 + ln-shift the R halves at ΔT from β', () => {
    const host = new MockCircuitHost();
    const ntc = new Ntc('ntc', 0, { rFixedOhms: 10_000, r0: 10_000, beta: 3950 });
    ntc.attach(host);
    // Independently recompute the expected wiper voltage from the divider law.
    const k = 273.15;
    const rAt = (tC: number): number => 10_000 * Math.exp(3950 * (1 / (tC + k) - 1 / (25 + k)));
    for (const t of [-10, 25, 37, 70]) {
      ntc.setTempC(t);
      const rn = rAt(t);
      const expected = (5 * rn) / (10_000 + rn);
      expect(ntc.volts).toBeCloseTo(expected, 3);
    }
  });

  it('re-solves on every setTempC and does not touch other channels', () => {
    const host = new MockCircuitHost();
    const ntc = new Ntc('ntc', 2);
    ntc.attach(host);
    ntc.setTempC(10);
    const cold = host.adc.get(2)!;
    ntc.setTempC(90);
    const hot = host.adc.get(2)!;
    expect(hot).toBeLessThan(cold);
    expect(host.adc.size).toBe(1); // only channel 2 was ever written
  });
});
