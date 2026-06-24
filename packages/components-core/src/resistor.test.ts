import { describe, it, expect } from 'vitest';
import { Resistor } from './resistor.js';
import { MockCircuitHost } from './mock-host.js';
import type { SimComponent } from './sdk.js';

describe('Resistor', () => {
  it('exposes its id and ohms from the constructor', () => {
    const r = new Resistor('r1', 220);
    expect(r.id).toBe('r1');
    expect(r.ohms).toBe(220);
  });

  it('keeps arbitrary resistance values (0, fractional, very large)', () => {
    expect(new Resistor('r0', 0).ohms).toBe(0);
    expect(new Resistor('rk', 4_700).ohms).toBe(4_700);
    expect(new Resistor('rm', 1_000_000).ohms).toBe(1_000_000);
    expect(new Resistor('rf', 0.5).ohms).toBeCloseTo(0.5);
  });

  it('attach() is a harmless no-op — drives nothing, watches nothing, schedules nothing', () => {
    const host = new MockCircuitHost();
    const r = new Resistor('r1', 1_000);

    expect(() => r.attach(host)).not.toThrow();

    // Did not drive any pin, set any ADC channel, or register any I2C device.
    expect(host.driven.size).toBe(0);
    expect(host.adc.size).toBe(0);
    expect(host.i2c.size).toBe(0);

    // Did not advance or schedule on the virtual-time kernel.
    expect(host.now()).toBe(0);
    host.advance(1_000_000);
    expect(host.now()).toBe(1_000_000);

    // ohms is unchanged by attaching.
    expect(r.ohms).toBe(1_000);
  });

  it('attach() is idempotent across repeated calls', () => {
    const host = new MockCircuitHost();
    const r = new Resistor('r1', 330);
    r.attach(host);
    r.attach(host);
    expect(host.driven.size).toBe(0);
    expect(host.adc.size).toBe(0);
    expect(host.i2c.size).toBe(0);
  });

  it('exposes no per-instruction tick hook (purely passive)', () => {
    const r: SimComponent = new Resistor('r1', 470);
    expect(r.tick).toBeUndefined();
  });
});
