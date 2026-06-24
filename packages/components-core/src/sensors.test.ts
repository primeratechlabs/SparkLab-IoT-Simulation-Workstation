import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { DigitalSensor } from './digital-sensor.js';
import { AnalogSensor } from './analog-sensor.js';

describe('DigitalSensor (PIR / tilt)', () => {
  it('drives its OUT pin LOW when idle and HIGH when active', () => {
    const host = new MockCircuitHost();
    const pir = new DigitalSensor('pir1', 2);
    pir.attach(host);
    expect(host.driven.get(2)).toBe('low');

    pir.setActive(true);
    expect(pir.active).toBe(true);
    expect(host.driven.get(2)).toBe('high'); // motion detected → firmware digitalRead sees HIGH

    pir.setActive(false);
    expect(host.driven.get(2)).toBe('low');
  });

  it('honours the initial active state', () => {
    const host = new MockCircuitHost();
    new DigitalSensor('tilt1', 3, { active: true }).attach(host);
    expect(host.driven.get(3)).toBe('high');
  });
});

describe('AnalogSensor (gas / flame)', () => {
  it('presents its 0..1 reading as a fraction of Vref on the ADC channel', () => {
    const host = new MockCircuitHost();
    const gas = new AnalogSensor('gas1', 0, { value: 0.5, vref: 5 });
    gas.attach(host);
    expect(host.adc.get(0)).toBeCloseTo(2.5, 5); // 50% of 5V

    gas.setValue(1);
    expect(host.adc.get(0)).toBeCloseTo(5, 5);
    gas.setValue(0);
    expect(host.adc.get(0)).toBeCloseTo(0, 5);
  });

  it('clamps the reading to 0..1', () => {
    const host = new MockCircuitHost();
    const s = new AnalogSensor('s', 1, { vref: 3.3 });
    s.attach(host);
    s.setValue(2); // over-range
    expect(host.adc.get(1)).toBeCloseTo(3.3, 5);
    s.setValue(-1);
    expect(host.adc.get(1)).toBeCloseTo(0, 5);
  });
});
