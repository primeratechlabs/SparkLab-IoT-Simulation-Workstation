import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { Relay } from './relay.js';

describe('Relay', () => {
  it('rests on NC / de-energized before the MCU drives the pin', () => {
    const host = new MockCircuitHost();
    const relay = new Relay('relay1', 7);
    relay.attach(host);
    expect(relay.energized).toBe(false);
    expect(relay.position).toBe('NC');
    expect(relay.switches).toBe(0);
  });

  it('energizes (COM → NO) on HIGH and de-energizes (COM → NC) on LOW', () => {
    const host = new MockCircuitHost();
    const relay = new Relay('relay1', 7);
    relay.attach(host);

    host.mcuWrite(7, 'high');
    expect(relay.energized).toBe(true);
    expect(relay.position).toBe('NO');

    host.mcuWrite(7, 'low');
    expect(relay.energized).toBe(false);
    expect(relay.position).toBe('NC');

    // One transition into NO, one back to NC.
    expect(relay.switches).toBe(2);
  });

  it('inverts with activeLow: LOW energizes (NO), HIGH de-energizes (NC)', () => {
    const host = new MockCircuitHost();
    const relay = new Relay('relay1', 7, { activeLow: true });
    relay.attach(host);
    // Mock defaults a pin to LOW → an active-low coil is already energized.
    expect(relay.energized).toBe(true);
    expect(relay.position).toBe('NO');

    host.mcuWrite(7, 'high');
    expect(relay.energized).toBe(false);
    expect(relay.position).toBe('NC');

    host.mcuWrite(7, 'low');
    expect(relay.energized).toBe(true);
    expect(relay.position).toBe('NO');
  });

  it('picks up the pin level already present at attach time', () => {
    const host = new MockCircuitHost();
    host.mcuWrite(7, 'high'); // MCU drove the line before the relay attached
    const relay = new Relay('relay1', 7);
    relay.attach(host);
    expect(relay.energized).toBe(true);
    expect(relay.position).toBe('NO');
    // No spurious transition: it was born energized, only one edge to count.
    expect(relay.switches).toBe(1);
  });

  it('ignores repeated same-level writes (no extra switches, contact debounce)', () => {
    const host = new MockCircuitHost();
    const relay = new Relay('relay1', 7);
    relay.attach(host);

    host.mcuWrite(7, 'high');
    host.mcuWrite(7, 'high');
    host.mcuWrite(7, 'high');
    expect(relay.switches).toBe(1);
    expect(relay.position).toBe('NO');

    host.mcuWrite(7, 'low');
    host.mcuWrite(7, 'low');
    expect(relay.switches).toBe(2);
    expect(relay.position).toBe('NC');
  });

  it('does not drive the control pin or touch the ADC/I2C surface (pure sink)', () => {
    const host = new MockCircuitHost();
    const relay = new Relay('relay1', 7);
    relay.attach(host);
    host.mcuWrite(7, 'high');
    expect(host.driven.size).toBe(0);
    expect(host.adc.size).toBe(0);
    expect(host.i2c.size).toBe(0);
  });

  it('toggles cleanly across many cycles', () => {
    const host = new MockCircuitHost();
    const relay = new Relay('relay1', 7);
    relay.attach(host);
    for (let i = 0; i < 5; i++) {
      host.mcuWrite(7, 'high');
      host.mcuWrite(7, 'low');
    }
    expect(relay.switches).toBe(10);
    expect(relay.energized).toBe(false);
    expect(relay.position).toBe('NC');
  });
});
