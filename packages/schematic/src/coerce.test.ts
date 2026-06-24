import { describe, it, expect } from 'vitest';
import { coerceNum, coerceBool, coerceI2cAddress } from './coerce.js';

describe('coerce', () => {
  it('coerceNum: number, numeric string, else default; rejects non-finite', () => {
    expect(coerceNum({ x: 5 }, 'x', 1)).toBe(5);
    expect(coerceNum({ x: '7' }, 'x', 1)).toBe(7);
    expect(coerceNum({ x: 'abc' }, 'x', 1)).toBe(1);
    expect(coerceNum({}, 'x', 1)).toBe(1);
    expect(coerceNum({ x: Infinity }, 'x', 1)).toBe(1);
  });

  it('coerceBool: true / "true" / "1" / 1 are true; else default', () => {
    expect(coerceBool({ b: true }, 'b', false)).toBe(true);
    expect(coerceBool({ b: 'true' }, 'b', false)).toBe(true);
    expect(coerceBool({ b: '1' }, 'b', false)).toBe(true);
    expect(coerceBool({ b: 1 }, 'b', false)).toBe(true);
    expect(coerceBool({ b: false }, 'b', true)).toBe(false);
    expect(coerceBool({}, 'b', true)).toBe(true);
  });

  it('coerceI2cAddress: clamps to a valid 7-bit address, else default', () => {
    expect(coerceI2cAddress({ address: 0x27 }, 0x3c)).toBe(0x27);
    expect(coerceI2cAddress({ address: 200 }, 0x3c)).toBe(0x3c);
    expect(coerceI2cAddress({ address: -1 }, 0x3c)).toBe(0x3c);
    expect(coerceI2cAddress({ address: 12.5 }, 0x3c)).toBe(0x3c);
    expect(coerceI2cAddress({}, 0x3c)).toBe(0x3c);
  });
});
