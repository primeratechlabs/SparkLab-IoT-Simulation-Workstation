import { describe, it, expect } from 'vitest';
import { XtensaCpu, SimpleBus, XtensaTrap } from './xtensa.js';

/**
 * Validates the Xtensa interpreter against REAL esp-clang (call0, -windowed) codegen:
 * a 69-byte flat image of `compute(n)=sum 1..n; *out=compute(*in)` that esp-clang
 * strength-reduced to the closed form n(n+1)/2 (mull + muluh + src/ssl + addx2). If the
 * interpreter decodes + executes all of these correctly, it reproduces the right sum.
 * Frozen as a fixture so the test runs without the (gitignored) toolchain.
 *
 * Source: esp-clang --target=xtensa-esp-elf -mcpu=esp32 -O2 -Xclang -target-feature
 *         -Xclang -windowed; linked .literal-before-.text at base 0, entry = 0x4.
 * The image reads n from mem[0x100] and writes the result to mem[0x200], then `break`.
 */
const PROGRAM = Uint8Array.of(
  36,
  0,
  0,
  0,
  130,
  193,
  240,
  29,
  8,
  9,
  1,
  130,
  161,
  0,
  192,
  32,
  0,
  40,
  8,
  129,
  251,
  255,
  192,
  8,
  0,
  130,
  162,
  0,
  192,
  32,
  0,
  41,
  8,
  240,
  65,
  0,
  166,
  18,
  25,
  130,
  194,
  254,
  11,
  146,
  128,
  169,
  130,
  128,
  137,
  162,
  28,
  249,
  0,
  25,
  64,
  160,
  136,
  129,
  128,
  130,
  144,
  11,
  40,
  13,
  240,
  12,
  2,
  13,
  240,
);
const ENTRY = 0x4;

function sumTo(n: number): number {
  const bus = new SimpleBus(new Uint8Array(0x4000));
  bus.ram.set(PROGRAM, 0);
  bus.write32(0x100, n); // input
  bus.write32(0x200, 0); // clear output
  const cpu = new XtensaCpu(bus);
  cpu.pc = ENTRY;
  cpu.setReg(1, 0x3000); // a1 = stack pointer
  for (let k = 0; k < 200000; k++) {
    try {
      cpu.step();
    } catch (e) {
      if (e instanceof XtensaTrap) break; // trailing __builtin_trap()
      throw e;
    }
  }
  return bus.read32(0x200) | 0;
}

describe('xtensa — real esp-clang -O2 codegen (frozen fixture, call0)', () => {
  it('computes sum 1..n for several inputs (n(n+1)/2 via mull/muluh/src)', () => {
    expect(sumTo(1)).toBe(1);
    expect(sumTo(10)).toBe(55);
    expect(sumTo(100)).toBe(5050);
    expect(sumTo(1000)).toBe(500500);
    expect(sumTo(0)).toBe(0);
  });
});
