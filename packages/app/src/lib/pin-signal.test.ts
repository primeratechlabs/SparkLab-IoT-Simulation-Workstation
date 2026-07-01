import { describe, it, expect } from 'vitest';
import { wireColor } from './pin-signal';

describe('wireColor — signal-typed wire colouring', () => {
  it('colours any GND wire black (GND wins over power)', () => {
    expect(wireColor('GND', '13', 0)).toBe('#3B3530');
    expect(wireColor('A0', 'GND', 3)).toBe('#3B3530');
    expect(wireColor('GND', '5V', 0)).toBe('#3B3530'); // GND check runs first
  });
  it('colours power wires (3V3 / 5V / VIN) red', () => {
    expect(wireColor('3V3', 'VCC', 0)).toBe('#D7503B');
    expect(wireColor('A', '5V', 1)).toBe('#D7503B');
    expect(wireColor('VIN', 'sig', 2)).toBe('#D7503B');
  });
  it('cycles a palette for signal wires by index', () => {
    const a = wireColor('13', 'A', 0);
    const b = wireColor('12', 'A', 1);
    expect(a).not.toBe(b);
    expect(wireColor('11', 'A', 6)).toBe(a); // palette has 6 entries → wraps
  });
  it('reads the breadboard RAIL role (− rails = GND, + rails = power)', () => {
    expect(wireColor('C', 'tn15', 0)).toBe('#3B3530'); // LED cathode → top − rail = ground
    expect(wireColor('GND', 'bn3', 1)).toBe('#3B3530'); // bottom − rail = ground
    expect(wireColor('V+', 'tp5', 2)).toBe('#D7503B'); // servo V+ → top + rail = power
    expect(wireColor('VCC', 'bp9', 3)).toBe('#D7503B'); // bottom + rail = power
    expect(wireColor('sig', 'e7', 4)).not.toMatch(/#3B3530|#D7503B/); // a column hole is a signal net
  });
  it('recognises component power pin names (VCC / V+) as power', () => {
    expect(wireColor('VCC', 'AO', 0)).toBe('#D7503B');
    expect(wireColor('PWM', 'V+', 1)).toBe('#D7503B');
  });
});
