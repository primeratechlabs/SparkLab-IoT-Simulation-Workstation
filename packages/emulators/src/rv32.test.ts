import { describe, it, expect } from 'vitest';
import { Rv32Cpu, SimpleBus, Rv32Trap, CAUSE_ECALL_M, CAUSE_BREAKPOINT } from './rv32.js';

/** Minimal instruction encoders (the inverse of the decoder) so tests read as assembly. */
const reg = { zero: 0, ra: 1, sp: 2, t0: 5, t1: 6, t2: 7, a0: 10, a1: 11, a2: 12, a3: 13 };
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
const J = (imm: number, rd: number) =>
  ((((imm >> 20) & 1) << 31) |
    (((imm >> 1) & 0x3ff) << 21) |
    (((imm >> 11) & 1) << 20) |
    (((imm >> 12) & 0xff) << 12) |
    (rd << 7) |
    0x6f) >>>
  0;

// instruction shortcuts
const addi = (rd: number, rs1: number, imm: number) => I(imm, rs1, 0, rd, 0x13);
const add = (rd: number, rs1: number, rs2: number) => R(0, rs2, rs1, 0, rd, 0x33);
const sub = (rd: number, rs1: number, rs2: number) => R(0x20, rs2, rs1, 0, rd, 0x33);
const lui = (rd: number, imm: number) => U(imm, rd, 0x37);
const auipc = (rd: number, imm: number) => U(imm, rd, 0x17);
const lw = (rd: number, rs1: number, imm: number) => I(imm, rs1, 2, rd, 0x03);
const sw = (rs2: number, rs1: number, imm: number) => S(imm, rs2, rs1, 2, 0x23);
const sb = (rs2: number, rs1: number, imm: number) => S(imm, rs2, rs1, 0, 0x23);
const lbu = (rd: number, rs1: number, imm: number) => I(imm, rs1, 4, rd, 0x03);
const blt = (rs1: number, rs2: number, imm: number) => B(imm, rs2, rs1, 4);
const bne = (rs1: number, rs2: number, imm: number) => B(imm, rs2, rs1, 1);
const jal = (rd: number, imm: number) => J(imm, rd);
const jalr = (rd: number, rs1: number, imm: number) => I(imm, rs1, 0, rd, 0x67);
const mul = (rd: number, rs1: number, rs2: number) => R(1, rs2, rs1, 0, rd, 0x33);
const mulh = (rd: number, rs1: number, rs2: number) => R(1, rs2, rs1, 1, rd, 0x33);
const div = (rd: number, rs1: number, rs2: number) => R(1, rs2, rs1, 4, rd, 0x33);
const rem = (rd: number, rs1: number, rs2: number) => R(1, rs2, rs1, 6, rd, 0x33);
const ebreak = () => 0x00100073;
const ecall = () => 0x00000073;

/** Load a program (32-bit words) at base into a CPU with `ramSize` bytes of RAM, pc=base. */
function makeCpu(words: number[], base = 0, ramSize = 0x10000): Rv32Cpu {
  const bus = new SimpleBus(new Uint8Array(ramSize));
  words.forEach((w, i) => bus.write32(base + i * 4, w >>> 0));
  const cpu = new Rv32Cpu(bus);
  cpu.pc = base;
  return cpu;
}

/** Run until EBREAK (or `cap` instructions). Returns the cpu for assertions. */
function runToBreak(cpu: Rv32Cpu, cap = 100000): Rv32Cpu {
  for (let i = 0; i < cap; i++) {
    try {
      cpu.step();
    } catch (e) {
      if (e instanceof Rv32Trap && e.cause === CAUSE_BREAKPOINT) return cpu;
      throw e;
    }
  }
  throw new Error('did not hit EBREAK within cap');
}

describe('rv32 — base integer ISA', () => {
  it('ADDI / ADD / SUB compute and x0 stays zero', () => {
    const cpu = makeCpu([
      addi(reg.a0, reg.zero, 100), // a0 = 100
      addi(reg.a1, reg.zero, 23), // a1 = 23
      add(reg.a2, reg.a0, reg.a1), // a2 = 123
      sub(reg.a3, reg.a0, reg.a1), // a3 = 77
      addi(reg.zero, reg.zero, 5), // x0 must stay 0
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a2)).toBe(123);
    expect(cpu.getReg(reg.a3)).toBe(77);
    expect(cpu.getReg(reg.zero)).toBe(0);
  });

  it('LUI + ADDI builds a full 32-bit constant; AUIPC is PC-relative', () => {
    const cpu = makeCpu([
      lui(reg.a0, 0xcafe000 << 0), // a0 = 0xCAFE000 << ... actually upper 20 bits
      addi(reg.a0, reg.a0, 0x123), // a0 = 0xCAFE123
      auipc(reg.a1, 0x1000), // a1 = pc(=8) + 0x1000
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0) >>> 0).toBe(0x0cafe123);
    expect(cpu.getReg(reg.a1) >>> 0).toBe((8 + 0x1000) >>> 0);
  });

  it('runs a branch loop: sum 1..10 == 55', () => {
    // a0=0; a1=1; loop: a0+=a1; a1++; if a1<11 goto loop; ebreak
    const cpu = makeCpu([
      addi(reg.a0, reg.zero, 0), // 0x00
      addi(reg.a1, reg.zero, 1), // 0x04
      add(reg.a0, reg.a0, reg.a1), // 0x08 loop
      addi(reg.a1, reg.a1, 1), // 0x0c
      addi(reg.t0, reg.zero, 11), // 0x10
      blt(reg.a1, reg.t0, -12), // 0x14 -> back to 0x08 (loop) while a1 < 11
      ebreak(), // 0x18
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0)).toBe(55);
    expect(cpu.getReg(reg.a1)).toBe(11);
  });

  it('LW / SW / SB / LBU round-trip through RAM', () => {
    const cpu = makeCpu([
      addi(reg.a0, reg.zero, 0x123), // a0 = 0x123
      addi(reg.t0, reg.zero, 0x200), // ptr = 0x200
      sw(reg.a0, reg.t0, 0), // mem[0x200] = 0x123
      lw(reg.a1, reg.t0, 0), // a1 = mem[0x200]
      addi(reg.a2, reg.zero, 0x5a), // a2 = 0x5A
      sb(reg.a2, reg.t0, 4), // mem[0x204] = 0x5A
      lbu(reg.a3, reg.t0, 4), // a3 = 0x5A
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a1)).toBe(0x123);
    expect(cpu.getReg(reg.a3)).toBe(0x5a);
    expect(cpu.bus.read8(0x204)).toBe(0x5a);
  });
});

describe('rv32 — M extension', () => {
  it('MUL / MULH / DIV / REM with signed semantics', () => {
    const cpu = makeCpu([
      addi(reg.a0, reg.zero, -7), // a0 = -7
      addi(reg.a1, reg.zero, 6), // a1 = 6
      mul(reg.a2, reg.a0, reg.a1), // a2 = -42
      div(reg.a3, reg.a0, reg.a1), // a3 = -1 (-7/6 trunc)
      rem(reg.t0, reg.a0, reg.a1), // t0 = -1 (-7 % 6)
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a2)).toBe(-42);
    expect(cpu.getReg(reg.a3)).toBe(-1);
    expect(cpu.getReg(reg.t0)).toBe(-1);
  });

  it('MULH returns the high word of a 64-bit signed product', () => {
    const cpu = makeCpu([
      lui(reg.a0, 0x10000 << 12), // a0 = 0x10000000
      lui(reg.a1, 0x10000 << 12), // a1 = 0x10000000
      mulh(reg.a2, reg.a0, reg.a1), // (0x10000000)^2 = 0x0100000000000000 -> high = 0x01000000
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a2) >>> 0).toBe(0x01000000);
  });

  it('DIV by zero returns -1 and REM by zero returns the dividend (spec)', () => {
    const cpu = makeCpu([
      addi(reg.a0, reg.zero, 42),
      addi(reg.a1, reg.zero, 0),
      div(reg.a2, reg.a0, reg.a1), // -1
      rem(reg.a3, reg.a0, reg.a1), // 42
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a2)).toBe(-1);
    expect(cpu.getReg(reg.a3)).toBe(42);
  });
});

describe('rv32 — control transfer + traps', () => {
  it('JAL/JALR implement a call/return (ra link register)', () => {
    // main: jal ra, +12 (call); after return ebreak. fn: a0=99; jalr x0, ra, 0 (ret)
    const cpu = makeCpu([
      jal(reg.ra, 12), // 0x00 -> call fn at 0x0c, ra=0x04
      addi(reg.a1, reg.zero, 7), // 0x04 (after return)
      ebreak(), // 0x08
      addi(reg.a0, reg.zero, 99), // 0x0c fn: a0=99
      jalr(reg.zero, reg.ra, 0), // 0x10 ret
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0)).toBe(99);
    expect(cpu.getReg(reg.a1)).toBe(7); // proves we returned to 0x04
    expect(cpu.getReg(reg.ra)).toBe(0x04);
  });

  it('ECALL raises a machine trap the host can catch', () => {
    const cpu = makeCpu([addi(reg.a0, reg.zero, 1), ecall(), addi(reg.a0, reg.zero, 2)]);
    cpu.step(); // addi
    expect(() => cpu.step()).toThrow(Rv32Trap);
    try {
      makeCpu([ecall()]).step();
    } catch (e) {
      expect((e as Rv32Trap).cause).toBe(CAUSE_ECALL_M);
    }
  });

  it('CSR read/write via CSRRW round-trips', () => {
    const MTVEC = 0x305;
    const cpu = makeCpu([
      addi(reg.a0, reg.zero, 0x40), // a0 = 0x40
      I(MTVEC, reg.a0, 1, reg.t0, 0x73), // csrrw t0, mtvec, a0  (t0=old mtvec=0, mtvec=0x40)
      I(MTVEC, reg.zero, 2, reg.a1, 0x73), // csrrs a1, mtvec, x0 (a1 = mtvec = 0x40)
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.csr[MTVEC]).toBe(0x40);
    expect(cpu.getReg(reg.a1)).toBe(0x40);
  });
});

describe('rv32 — C (compressed) extension', () => {
  // Hand-verified 16-bit RVC encodings (little-endian halfwords). The decoder must expand
  // each to the right 32-bit op and the program must compute the same result.
  it('decodes c.li / c.addi / c.mv / c.add and advances pc by 2 per 16-bit insn', () => {
    const bus = new SimpleBus(new Uint8Array(0x1000));
    // c.li a0, 5      = 0x4515
    // c.addi a0, 1    = 0x0505
    // c.mv a1, a0     = 0x85aa   (a1 = a0 = 6)
    // c.add a1, a0    = 0x95aa   (a1 = a1 + a0 = 12)  [= c.mv | bit12]
    // c.ebreak        = 0x9002
    const halfs = [0x4515, 0x0505, 0x85aa, 0x95aa, 0x9002];
    halfs.forEach((h, i) => bus.write16(i * 2, h));
    const cpu = new Rv32Cpu(bus);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0)).toBe(6); // 5 + 1
    expect(cpu.getReg(reg.a1)).toBe(12); // 6 + 6
    expect(cpu.pc).toBe(10); // 5 × 2-byte instructions
  });

  it('c.swsp / c.lwsp move a word through the stack pointer', () => {
    const bus = new SimpleBus(new Uint8Array(0x1000));
    // li sp, 0x200 (use 32-bit addi for setup), then compressed stack ops
    bus.write32(0, addi(reg.sp, reg.zero, 0x200)); // 0x00 (4 bytes)
    bus.write32(4, addi(reg.a0, reg.zero, 0x77)); // 0x04 a0 = 0x77
    // c.swsp a0, 0(sp)  = 0xc02a
    bus.write16(8, 0xc02a); // 0x08 mem[sp+0] = a0
    // c.lwsp a1, 0(sp)  = 0x4582
    bus.write16(10, 0x4582); // 0x0a a1 = mem[sp+0]
    bus.write32(12, ebreak()); // 0x0c
    const cpu = new Rv32Cpu(bus);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a1)).toBe(0x77);
    expect(cpu.bus.read32(0x200)).toBe(0x77);
  });
});

describe('rv32 — real clang -Os codegen (frozen fixture, rv32imc)', () => {
  // 46-byte flat binary emitted by the native clang 19.1.0 we built (--target=riscv32
  // -march=rv32imc -mabi=ilp32 -Os), linked at 0x0. Source: read n from mem[0x2000],
  // compute sum 1..n, store to mem[0x1000], __builtin_trap(). clang strength-reduced the
  // loop to the closed form n(n+1)/2 using mul/mulhu + compressed ops — so this exercises
  // the M extension AND a dense mix of RVC instructions on REAL compiler output.
  const PROGRAM = Uint8Array.of(
    0x09,
    0x65,
    0x08,
    0x41,
    0x81,
    0x45,
    0x63,
    0x51,
    0xa0,
    0x02,
    0x93,
    0x15,
    0x15,
    0x00,
    0x13,
    0x06,
    0xf5,
    0xff,
    0x79,
    0x15,
    0xb3,
    0x06,
    0xa6,
    0x02,
    0x33,
    0x35,
    0xa6,
    0x02,
    0x7e,
    0x05,
    0x85,
    0x82,
    0x55,
    0x8d,
    0x2e,
    0x95,
    0x93,
    0x05,
    0xf5,
    0xff,
    0x05,
    0x65,
    0x0c,
    0xc1,
    0x00,
    0x00,
  );

  const sumTo = (n: number): number => {
    const bus = new SimpleBus(new Uint8Array(0x4000));
    bus.ram.set(PROGRAM, 0); // load .text at 0x0
    bus.write32(0x2000, n); // input n
    const cpu = new Rv32Cpu(bus);
    // run until the trailing __builtin_trap() (unimp = 0x0000 → illegal-instruction trap)
    for (let i = 0; i < 1000; i++) {
      try {
        cpu.step();
      } catch (e) {
        if (e instanceof Rv32Trap) break;
        throw e;
      }
    }
    return bus.read32(0x1000) | 0;
  };

  it('computes sum 1..n for several inputs (matches n(n+1)/2)', () => {
    expect(sumTo(1)).toBe(1);
    expect(sumTo(10)).toBe(55);
    expect(sumTo(100)).toBe(5050);
    expect(sumTo(1000)).toBe(500500);
    expect(sumTo(0)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// QA hardening (Stage 4): the ISA corners the happy-path tests above don't hit —
// overflow/by-zero division, unsigned high-multiply, sign-extending loads, signed
// vs unsigned compares/shifts, and unsigned branches. Each is a place a subtle
// `| 0` / `>>> 0` mistake would silently corrupt real firmware execution.
describe('rv32 — M extension edge cases (overflow / by-zero / unsigned)', () => {
  const divu = (rd: number, rs1: number, rs2: number) => R(1, rs2, rs1, 5, rd, 0x33);
  const remu = (rd: number, rs1: number, rs2: number) => R(1, rs2, rs1, 7, rd, 0x33);
  const mulhu = (rd: number, rs1: number, rs2: number) => R(1, rs2, rs1, 3, rd, 0x33);
  const mulhsu = (rd: number, rs1: number, rs2: number) => R(1, rs2, rs1, 2, rd, 0x33);

  it('DIV/REM of INT_MIN by -1 saturate per spec (quotient INT_MIN, remainder 0)', () => {
    const cpu = makeCpu([
      lui(reg.t0, 0x80000000), // t0 = INT_MIN (0x80000000)
      addi(reg.t1, reg.zero, -1), // t1 = -1
      div(reg.a0, reg.t0, reg.t1), // INT_MIN / -1 overflows -> INT_MIN
      rem(reg.a1, reg.t0, reg.t1), // INT_MIN % -1 -> 0
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0) >>> 0).toBe(0x80000000);
    expect(cpu.getReg(reg.a1)).toBe(0);
  });

  it('DIVU/REMU treat operands as unsigned and handle divide-by-zero', () => {
    const cpu = makeCpu([
      addi(reg.t0, reg.zero, -1), // t0 = 0xffffffff (huge unsigned)
      addi(reg.t1, reg.zero, 2),
      divu(reg.a0, reg.t0, reg.t1), // 0xffffffff / 2 = 0x7fffffff
      remu(reg.a1, reg.t0, reg.t1), // 0xffffffff % 2 = 1
      addi(reg.t2, reg.zero, 0),
      divu(reg.a2, reg.t0, reg.t2), // /0 -> all ones
      remu(reg.a3, reg.t0, reg.t2), // %0 -> dividend
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0) >>> 0).toBe(0x7fffffff);
    expect(cpu.getReg(reg.a1)).toBe(1);
    expect(cpu.getReg(reg.a2) >>> 0).toBe(0xffffffff);
    expect(cpu.getReg(reg.a3) >>> 0).toBe(0xffffffff);
  });

  it('MULHU/MULHSU return the correct high word with (un)signed operands', () => {
    const cpu = makeCpu([
      lui(reg.t0, 0x80000000), // t0 = 0x80000000
      lui(reg.t1, 0x80000000), // t1 = 0x80000000
      mulhu(reg.a0, reg.t0, reg.t1), // (2^31)*(2^31) unsigned = 2^62 -> high 0x40000000
      mulhsu(reg.a1, reg.t0, reg.t1), // (-2^31)*(2^31 unsigned) = -2^62 -> high 0xC0000000
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0) >>> 0).toBe(0x40000000);
    expect(cpu.getReg(reg.a1) >>> 0).toBe(0xc0000000);
  });
});

describe('rv32 — loads/compares/shifts/branches (sign discipline)', () => {
  const lb = (rd: number, rs1: number, imm: number) => I(imm, rs1, 0, rd, 0x03);
  const lh = (rd: number, rs1: number, imm: number) => I(imm, rs1, 1, rd, 0x03);
  const lhu = (rd: number, rs1: number, imm: number) => I(imm, rs1, 5, rd, 0x03);
  const sh = (rs2: number, rs1: number, imm: number) => S(imm, rs2, rs1, 1, 0x23);
  const slt = (rd: number, rs1: number, rs2: number) => R(0, rs2, rs1, 2, rd, 0x33);
  const sltu = (rd: number, rs1: number, rs2: number) => R(0, rs2, rs1, 3, rd, 0x33);
  const slti = (rd: number, rs1: number, imm: number) => I(imm, rs1, 2, rd, 0x13);
  const sltiu = (rd: number, rs1: number, imm: number) => I(imm, rs1, 3, rd, 0x13);
  const sra = (rd: number, rs1: number, rs2: number) => R(0x20, rs2, rs1, 5, rd, 0x33);
  const srl = (rd: number, rs1: number, rs2: number) => R(0, rs2, rs1, 5, rd, 0x33);
  const srai = (rd: number, rs1: number, shamt: number) => I(0x400 | shamt, rs1, 5, rd, 0x13);
  const srli = (rd: number, rs1: number, shamt: number) => I(shamt, rs1, 5, rd, 0x13);
  const bltu = (rs1: number, rs2: number, imm: number) => B(imm, rs2, rs1, 6);
  const bgeu = (rs1: number, rs2: number, imm: number) => B(imm, rs2, rs1, 7);

  it('LB/LH sign-extend, LBU/LHU zero-extend, SB/SH round-trip through RAM', () => {
    const cpu = makeCpu([
      lui(reg.t0, 0x1000), // base = 0x1000
      addi(reg.a0, reg.zero, -1), // 0xffffffff
      sb(reg.a0, reg.t0, 0), // mem[0x1000] byte = 0xff
      lb(reg.a1, reg.t0, 0), // sign-extend -> -1
      lbu(reg.a2, reg.t0, 0), // zero-extend -> 255
      lui(reg.t1, 0x8000), // t1 = 0x8000
      sh(reg.t1, reg.t0, 4), // mem[0x1004] halfword = 0x8000
      lh(reg.a3, reg.t0, 4), // sign-extend -> -32768
      lhu(reg.t2, reg.t0, 4), // zero-extend -> 32768
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a1)).toBe(-1);
    expect(cpu.getReg(reg.a2)).toBe(255);
    expect(cpu.getReg(reg.a3)).toBe(-32768);
    expect(cpu.getReg(reg.t2)).toBe(32768);
  });

  it('SLT/SLTI are signed, SLTU/SLTIU are unsigned', () => {
    const cpu = makeCpu([
      addi(reg.t0, reg.zero, -1), // 0xffffffff
      addi(reg.t1, reg.zero, 1),
      slt(reg.a0, reg.t0, reg.t1), // -1 < 1 (signed) -> 1
      sltu(reg.a1, reg.t0, reg.t1), // 0xffffffff < 1 (unsigned) -> 0
      slti(reg.a2, reg.t0, 0), // -1 < 0 -> 1
      sltiu(reg.a3, reg.t0, 1), // 0xffffffff < 1 (unsigned) -> 0
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0)).toBe(1);
    expect(cpu.getReg(reg.a1)).toBe(0);
    expect(cpu.getReg(reg.a2)).toBe(1);
    expect(cpu.getReg(reg.a3)).toBe(0);
  });

  it('SRA/SRAI are arithmetic, SRL/SRLI are logical', () => {
    const cpu = makeCpu([
      addi(reg.t0, reg.zero, -16), // 0xfffffff0
      addi(reg.t1, reg.zero, 2),
      sra(reg.a0, reg.t0, reg.t1), // arithmetic -> -4
      srl(reg.a1, reg.t0, reg.t1), // logical -> 0x3ffffffc
      srai(reg.a2, reg.t0, 2), // -4
      srli(reg.a3, reg.t0, 2), // 0x3ffffffc
      ebreak(),
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0)).toBe(-4);
    expect(cpu.getReg(reg.a1) >>> 0).toBe(0x3ffffffc);
    expect(cpu.getReg(reg.a2)).toBe(-4);
    expect(cpu.getReg(reg.a3) >>> 0).toBe(0x3ffffffc);
  });

  it('BLTU takes the branch on an unsigned comparison (1 < 0xffffffff)', () => {
    const cpu = makeCpu([
      addi(reg.a0, reg.zero, 1), // 0x00 a0 = 1 (sentinel)
      addi(reg.t0, reg.zero, -1), // 0x04 t0 = 0xffffffff
      addi(reg.t1, reg.zero, 1), // 0x08 t1 = 1
      bltu(reg.t1, reg.t0, 8), // 0x0c 1 < 0xffffffff unsigned -> jump to 0x14, skip clear
      addi(reg.a0, reg.zero, 0), // 0x10 (only runs if signed-compared, i.e. WRONG)
      ebreak(), // 0x14
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0)).toBe(1);
  });

  it('BGEU is unsigned: 1 >= 0xffffffff is false (branch not taken)', () => {
    const cpu = makeCpu([
      addi(reg.a0, reg.zero, 1), // 0x00
      addi(reg.t0, reg.zero, -1), // 0x04 0xffffffff
      addi(reg.t1, reg.zero, 1), // 0x08
      bgeu(reg.t1, reg.t0, 8), // 0x0c 1 >= 0xffffffff unsigned? no -> fall through
      addi(reg.a0, reg.zero, 0), // 0x10 runs -> a0 = 0
      ebreak(), // 0x14
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0)).toBe(0);
  });

  it('BNE drives a backward-branch countdown loop (sum 5..1 == 15)', () => {
    const cpu = makeCpu([
      addi(reg.a0, reg.zero, 0), // 0x00 sum = 0
      addi(reg.t0, reg.zero, 5), // 0x04 i = 5
      add(reg.a0, reg.a0, reg.t0), // 0x08 loop: sum += i
      addi(reg.t0, reg.t0, -1), // 0x0c i--
      bne(reg.t0, reg.zero, -8), // 0x10 if i != 0 -> back to 0x08
      ebreak(), // 0x14
    ]);
    runToBreak(cpu);
    expect(cpu.getReg(reg.a0)).toBe(15);
    expect(cpu.getReg(reg.t0)).toBe(0);
  });
});
