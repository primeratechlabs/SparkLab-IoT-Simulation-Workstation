import { describe, it, expect } from 'vitest';
import { solveResistiveNetwork, potentiometerWiperVolts, voltageToAdc } from './analog.js';

describe('DC resistive solver', () => {
  it('solves an even voltage divider (two equal resistors → half VCC)', () => {
    const v = solveResistiveNetwork({
      fixed: { VCC: 5, GND: 0 },
      resistors: [
        { a: 'VCC', b: 'M', ohms: 1000 },
        { a: 'M', b: 'GND', ohms: 1000 },
      ],
    });
    expect(v.M).toBeCloseTo(2.5, 6);
  });

  it('solves an uneven divider (Vout = VCC·Rb/(Ra+Rb))', () => {
    const v = solveResistiveNetwork({
      fixed: { VCC: 5, GND: 0 },
      resistors: [
        { a: 'VCC', b: 'M', ohms: 3000 }, // Ra
        { a: 'M', b: 'GND', ohms: 1000 }, // Rb
      ],
    });
    expect(v.M).toBeCloseTo(5 * (1000 / 4000), 6); // 1.25 V
  });

  it('solves a 3-resistor chain (two intermediate nodes)', () => {
    const v = solveResistiveNetwork({
      fixed: { VCC: 6, GND: 0 },
      resistors: [
        { a: 'VCC', b: 'A', ohms: 1000 },
        { a: 'A', b: 'B', ohms: 1000 },
        { a: 'B', b: 'GND', ohms: 1000 },
      ],
    });
    expect(v.A).toBeCloseTo(4, 6); // 6 * 2/3
    expect(v.B).toBeCloseTo(2, 6); // 6 * 1/3
  });
});

describe('potentiometer + ADC', () => {
  it('maps wiper position to voltage across the full sweep', () => {
    expect(potentiometerWiperVolts(5, 10000, 0)).toBeCloseTo(0, 3); // wiper at GND end
    expect(potentiometerWiperVolts(5, 10000, 0.5)).toBeCloseTo(2.5, 3);
    expect(potentiometerWiperVolts(5, 10000, 1)).toBeCloseTo(5, 3); // wiper at VCC end
  });

  it('converts voltage to a 10-bit ADC reading', () => {
    expect(voltageToAdc(0)).toBe(0);
    expect(voltageToAdc(5)).toBe(1023);
    expect(voltageToAdc(2.5)).toBe(512); // round(0.5*1023)=512
  });

  it('pot midpoint → ADC ≈ 512', () => {
    expect(voltageToAdc(potentiometerWiperVolts(5, 10000, 0.5))).toBeGreaterThanOrEqual(510);
    expect(voltageToAdc(potentiometerWiperVolts(5, 10000, 0.5))).toBeLessThanOrEqual(514);
  });

  it('handles a zero/negative total resistance without producing a bogus midpoint', () => {
    // A negative track slips past the `|| 1e-6` guard (which only fires on exactly 0):
    // both legs then collapse to the solver's 1e-9 floor and the wiper pins to VCC/2
    // for *every* position. Clamping totalOhms to a tiny positive restores a sensible
    // position-proportional divider (and keeps zero finite & in range).
    for (const pos of [0.3, 0.5, 0.7]) {
      const v = potentiometerWiperVolts(5, -10000, pos);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(5);
      expect(v).toBeCloseTo(5 * pos, 6); // would be a flat 2.5 V before the clamp
    }
    // Zero total: degenerate but must stay finite and bounded (no NaN/Inf).
    const vZero = potentiometerWiperVolts(5, 0, 0.5);
    expect(Number.isFinite(vZero)).toBe(true);
    expect(vZero).toBeGreaterThanOrEqual(0);
    expect(vZero).toBeLessThanOrEqual(5);
  });
});

describe('DC solver — degenerate resistances', () => {
  it('treats a zero-ohm resistor as a near-short without dividing by zero', () => {
    const v = solveResistiveNetwork({
      fixed: { VCC: 5, GND: 0 },
      resistors: [
        { a: 'VCC', b: 'M', ohms: 0 }, // short to VCC
        { a: 'M', b: 'GND', ohms: 1000 },
      ],
    });
    expect(Number.isFinite(v.M)).toBe(true);
    expect(v.M).toBeCloseTo(5, 3); // pulled hard to VCC
  });
});
