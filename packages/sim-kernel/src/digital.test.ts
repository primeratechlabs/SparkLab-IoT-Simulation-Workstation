import { describe, it, expect, vi } from 'vitest';
import { DigitalNet } from './digital.js';

describe('DigitalNet', () => {
  it('floats with no driver and no pull', () => {
    const net = new DigitalNet();
    expect(net.level).toBe('floating');
    expect(net.conflict).toBe(false);
  });

  it('a pull-up holds the net high until a pin drives it low (button to GND)', () => {
    const net = new DigitalNet();
    net.setPull('mcu', 'up');
    expect(net.level).toBe('high'); // released
    net.drive('button', 'low');
    expect(net.level).toBe('low'); // pressed
    net.drive('button', 'high-z');
    expect(net.level).toBe('high'); // released again
  });

  it('a strong driver overrides a pull resistor', () => {
    const net = new DigitalNet();
    net.setPull('r', 'down');
    expect(net.level).toBe('low');
    net.drive('mcu', 'high');
    expect(net.level).toBe('high');
  });

  it('flags contention (strong low + strong high = short) for the ERC', () => {
    const net = new DigitalNet();
    net.drive('a', 'high');
    expect(net.conflict).toBe(false);
    net.drive('b', 'low');
    expect(net.conflict).toBe(true);
    expect(net.level).toBe('low'); // resolved deterministically
    net.drive('b', 'high-z');
    expect(net.conflict).toBe(false);
    expect(net.level).toBe('high');
  });

  it('opposing pulls (up + down) with no driver float', () => {
    const net = new DigitalNet();
    net.setPull('a', 'up');
    net.setPull('b', 'down');
    expect(net.level).toBe('floating');
  });

  it('notifies listeners only on resolved-level change (no polling)', () => {
    const net = new DigitalNet();
    const seen: string[] = [];
    net.onChange((r) => seen.push(r.level));
    net.drive('mcu', 'high'); // floating → high
    net.drive('mcu', 'high'); // no change → no notify
    net.drive('mcu', 'low'); // high → low
    expect(seen).toEqual(['high', 'low']);
  });

  it('unsubscribe stops notifications', () => {
    const net = new DigitalNet();
    const cb = vi.fn();
    const off = net.onChange(cb);
    net.drive('mcu', 'high');
    off();
    net.drive('mcu', 'low');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
