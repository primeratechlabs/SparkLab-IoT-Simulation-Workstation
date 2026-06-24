import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { Joystick } from './joystick.js';

describe('Joystick', () => {
  it('rests both axes at centre (~mid-scale) and the button released', () => {
    const host = new MockCircuitHost();
    const js = new Joystick('js', { vert: 0, horz: 1, sel: 2 }); // vref default 5
    js.attach(host);
    expect(host.adc.get(0)).toBeCloseTo(2.5); // 0.5 * 5
    expect(host.adc.get(1)).toBeCloseTo(2.5);
    expect(host.driven.get(2)).toBe('high-z'); // not pressed (pull-up reads HIGH)
  });

  it('maps each axis 0..1 onto the full ADC range', () => {
    const host = new MockCircuitHost();
    const js = new Joystick('js', { vert: 0, horz: 1, sel: 2 });
    js.attach(host);
    js.setVert(1);
    js.setHorz(0);
    expect(host.adc.get(0)).toBeCloseTo(5); // vert full
    expect(host.adc.get(1)).toBeCloseTo(0); // horz min
    js.setVert(2); // clamps to 1
    expect(host.adc.get(0)).toBeCloseTo(5);
  });

  it('drives SEL low while pressed (active-low), high-z when released', () => {
    const host = new MockCircuitHost();
    const js = new Joystick('js', { vert: 0, horz: 1, sel: 2 });
    js.attach(host);
    js.press();
    expect(js.pressed).toBe(true);
    expect(host.driven.get(2)).toBe('low');
    js.release();
    expect(host.driven.get(2)).toBe('high-z');
  });

  it('honours a custom vref (e.g. ESP32 3.3V)', () => {
    const host = new MockCircuitHost();
    const js = new Joystick('js', { vert: 0, horz: 1 }, { vref: 3.3 });
    js.attach(host);
    js.setVert(1);
    expect(host.adc.get(0)).toBeCloseTo(3.3);
  });
});
