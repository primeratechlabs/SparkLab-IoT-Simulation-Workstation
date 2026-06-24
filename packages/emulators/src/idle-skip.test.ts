import { describe, it, expect } from 'vitest';
import { Rv32Cpu, SimpleBus } from './rv32.js';
import { C3Gpio, C3SysTimer, C3_GPIO_BASE, C3_SYSTIMER_BASE } from './esp32c3-soc.js';
import { MonitoredBus, runWithIdleSkip } from './idle-skip.js';

// ── rv32 encoders ────────────────────────────────────────────────────────────
const reg = { zero: 0, t0: 5, t1: 6, t2: 7, a0: 10, a1: 11, a2: 12, a3: 13 };
const R = (f7: number, rs2: number, rs1: number, f3: number, rd: number, op: number) =>
  ((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0;
const I = (imm: number, rs1: number, f3: number, rd: number, op: number) =>
  (((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0;
const S = (imm: number, rs2: number, rs1: number, f3: number, op: number) =>
  ((((imm >> 5) & 0x7f) << 25) |
    (rs2 << 20) |
    (rs1 << 15) |
    (f3 << 12) |
    ((imm & 0x1f) << 7) |
    op) >>>
  0;
const U = (imm: number, rd: number, op: number) => ((imm & 0xfffff000) | (rd << 7) | op) >>> 0;
const B = (imm: number, rs2: number, rs1: number, f3: number) =>
  ((((imm >> 12) & 1) << 31) |
    (((imm >> 5) & 0x3f) << 25) |
    (rs2 << 20) |
    (rs1 << 15) |
    (f3 << 12) |
    (((imm >> 1) & 0xf) << 8) |
    (((imm >> 11) & 1) << 7) |
    0x63) >>>
  0;
const lui = (rd: number, imm: number) => U(imm, rd, 0x37);
const lw = (rd: number, rs1: number, imm: number) => I(imm, rs1, 2, rd, 0x03);
const addi = (rd: number, rs1: number, imm: number) => I(imm, rs1, 0, rd, 0x13);
const sub = (rd: number, rs1: number, rs2: number) => R(0x20, rs2, rs1, 0, rd, 0x33);
const blt = (rs1: number, rs2: number, imm: number) => B(imm, rs2, rs1, 4);
const sw = (rs2: number, rs1: number, imm: number) => S(imm, rs2, rs1, 2, 0x23);
const ebreak = () => 0x00100073;

/** Mirrors delay(targetMs): read millis as start, spin reading millis until cur-start ≥ target,
 *  then write GPIO0 (observable). Loop body = lw/sub/blt (3 instr/iter). */
function delayProgram(targetMs: number): number[] {
  return [
    lui(reg.t1, 0x60010000), // SYSTIMER_BASE (millis @ +0)
    lui(reg.a3, 0x60004000), // GPIO_BASE
    lw(reg.t0, reg.t1, 0), // start = millis
    addi(reg.t2, reg.zero, targetMs),
    lw(reg.a0, reg.t1, 0), // loop @16: cur = millis
    sub(reg.a1, reg.a0, reg.t0),
    blt(reg.a1, reg.t2, -8), // if cur-start < target → loop
    addi(reg.a2, reg.zero, 1),
    sw(reg.a2, reg.a3, 4), // GPIO_OUT = 1
    ebreak(),
  ];
}

interface RunState {
  cycles: number;
  regs: number[];
  pc: number;
  gpioOut: number;
  steps: number;
  skipped?: number;
}

function load(bus: SimpleBus, words: number[]): void {
  words.forEach((w, i) => bus.write32(i * 4, w >>> 0));
}

/** Plain run: step every instruction until GPIO0 is driven high. */
function runPlain(targetMs: number, cyclesPerMs: number): RunState {
  const bus = new SimpleBus(new Uint8Array(0x4000));
  load(bus, delayProgram(targetMs));
  const gpio = new C3Gpio();
  const cpu = new Rv32Cpu(bus);
  bus.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, cyclesPerMs));
  bus.map(C3_GPIO_BASE, 0x800, gpio);
  cpu.pc = 0;
  let steps = 0;
  while (steps < 50_000_000 && gpio.level(0) !== 1) {
    cpu.step();
    steps++;
  }
  return { cycles: cpu.cycles, regs: Array.from(cpu.regs), pc: cpu.pc, gpioOut: gpio.out, steps };
}

/** Idle-skip run: same program, eliding dead millis-spin iterations. */
function runSkip(targetMs: number, cyclesPerMs: number): RunState {
  const inner = new SimpleBus(new Uint8Array(0x4000));
  load(inner, delayProgram(targetMs));
  const gpio = new C3Gpio();
  const mbus = new MonitoredBus(inner, C3_SYSTIMER_BASE);
  const cpu = new Rv32Cpu(mbus);
  inner.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, cyclesPerMs));
  inner.map(C3_GPIO_BASE, 0x800, gpio);
  cpu.pc = 0;
  const res = runWithIdleSkip(cpu, mbus, {
    millisAddr: C3_SYSTIMER_BASE,
    cyclesPerMs,
    maxSteps: 50_000_000,
    stopWhen: () => gpio.level(0) === 1,
  });
  return {
    cycles: cpu.cycles,
    regs: Array.from(cpu.regs),
    pc: cpu.pc,
    gpioOut: gpio.out,
    steps: res.steps,
    skipped: res.skippedCycles,
  };
}

describe('idle-skip — byte-identical to a full run (Stage 7, I3/I4)', () => {
  for (const targetMs of [1, 3, 10]) {
    for (const cyclesPerMs of [97, 1000, 4096]) {
      it(`delay(${targetMs}ms) @${cyclesPerMs} cyc/ms: identical final state, far fewer steps`, () => {
        const plain = runPlain(targetMs, cyclesPerMs);
        const skip = runSkip(targetMs, cyclesPerMs);

        // BYTE-IDENTICAL: same virtual cycles, registers, pc, and observable GPIO
        expect(skip.cycles).toBe(plain.cycles);
        expect(skip.regs).toEqual(plain.regs);
        expect(skip.pc).toBe(plain.pc);
        expect(skip.gpioOut).toBe(plain.gpioOut);
        expect(skip.gpioOut & 1).toBe(1);

        // performance: idle-skip executes far fewer real instructions
        expect(skip.skipped!).toBeGreaterThan(0);
        expect(skip.steps).toBeLessThan(plain.steps); // never more
        if (plain.steps > 500) expect(skip.steps).toBeLessThan(plain.steps / 5);
      });
    }
  }

  it('is reproducible: two idle-skip runs are identical', () => {
    const a = runSkip(7, 1000);
    const b = runSkip(7, 1000);
    expect(a).toEqual(b);
  });

  it('does not overshoot: GPIO is driven at the exact same virtual cycle as a full run', () => {
    const plain = runPlain(5, 2000);
    const skip = runSkip(5, 2000);
    expect(skip.cycles).toBe(plain.cycles); // the millis the firmware observed at the write is identical
  });
});

describe('idle-skip — safety rails', () => {
  it('never skips a loop that writes each iteration (no false fast-forward)', () => {
    // a loop that writes RAM every iteration while also reading millis: it is NOT a clean spin,
    // so the per-iteration write must break detection and nothing may be fast-forwarded.
    const prog = [
      lui(reg.t1, 0x60010000),
      addi(reg.a3, reg.zero, 0x100), // RAM addr
      addi(reg.a0, reg.zero, 0), // counter
      // loop @12:
      addi(reg.a0, reg.a0, 1),
      sw(reg.a0, reg.a3, 0), // write each iteration → dirty
      lw(reg.a1, reg.t1, 0), // read millis
      addi(reg.a2, reg.zero, 999), // never reached → loop keeps spinning
      blt(reg.a1, reg.a2, -16), // loop while millis < 999
      ebreak(),
    ];
    const inner = new SimpleBus(new Uint8Array(0x4000));
    load(inner, prog);
    const mbus = new MonitoredBus(inner, C3_SYSTIMER_BASE);
    const cpu = new Rv32Cpu(mbus);
    inner.map(C3_SYSTIMER_BASE, 0x10, new C3SysTimer(() => cpu.cycles, 200));
    cpu.pc = 0;
    const res = runWithIdleSkip(cpu, mbus, {
      millisAddr: C3_SYSTIMER_BASE,
      cyclesPerMs: 200,
      maxSteps: 5_000_000,
      stopWhen: () => cpu.cycles >= 2000, // stop mid-spin (well before the unreachable target)
    });
    expect(res.skippedCycles).toBe(0); // a write every iteration → never a clean spin → no skip
    expect(res.stopped).toBe('predicate');
  });
});
