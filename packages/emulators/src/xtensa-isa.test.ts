/**
 * STAGE 5 QA — per-instruction coverage of the Xtensa LX6 (call0) interpreter.
 *
 * The frozen-fixture test (xtensa.test.ts) only validates the arithmetic/shift/mul/call0
 * path of ONE straight-line esp-clang function. The interpreter is the highest-risk run-side
 * piece in the project, so this suite hand-encodes each instruction group — derived directly
 * from the field layout documented in xtensa.ts (verified there against objdump) — and asserts
 * the EXECUTED semantics in isolation. Runs in CI without the (gitignored) toolchain.
 *
 * Encoding (little-endian):
 *   wide (24-bit):   op0[3:0] t[7:4] s[11:8] r[15:12] op1[19:16] op2[23:20]
 *   narrow (16-bit): op0[3:0] t[7:4] s[11:8] r[15:12]   (op0 ∈ [8,13])
 */
import { describe, it, expect } from 'vitest';
import { XtensaCpu, SimpleBus, XtensaTrap } from './xtensa.js';

// ── byte encoders ───────────────────────────────────────────────────────────
const w = (op0: number, t: number, s: number, r: number, op1: number, op2: number): number[] => {
  const i =
    ((op0 & 0xf) |
      ((t & 0xf) << 4) |
      ((s & 0xf) << 8) |
      ((r & 0xf) << 12) |
      ((op1 & 0xf) << 16) |
      ((op2 & 0xf) << 20)) >>>
    0;
  return [i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff];
};
const n2 = (op0: number, t: number, s: number, r: number): number[] => {
  const i = ((op0 & 0xf) | ((t & 0xf) << 4) | ((s & 0xf) << 8) | ((r & 0xf) << 12)) & 0xffff;
  return [i & 0xff, (i >> 8) & 0xff];
};

// QRST (op0=0): r = dst, s/t = sources
const and = (r: number, s: number, t: number) => w(0, t, s, r, 0, 1);
const or = (r: number, s: number, t: number) => w(0, t, s, r, 0, 2);
const xor = (r: number, s: number, t: number) => w(0, t, s, r, 0, 3);
const add = (r: number, s: number, t: number) => w(0, t, s, r, 0, 8);
const addx2 = (r: number, s: number, t: number) => w(0, t, s, r, 0, 9);
const addx4 = (r: number, s: number, t: number) => w(0, t, s, r, 0, 0xa);
const addx8 = (r: number, s: number, t: number) => w(0, t, s, r, 0, 0xb);
const sub = (r: number, s: number, t: number) => w(0, t, s, r, 0, 0xc);
const subx2 = (r: number, s: number, t: number) => w(0, t, s, r, 0, 0xd);
const subx4 = (r: number, s: number, t: number) => w(0, t, s, r, 0, 0xe);
const neg = (r: number, t: number) => w(0, t, 0, r, 0, 6);
const abs = (r: number, t: number) => w(0, t, 1, r, 0, 6);
// shifts (op1=1)
const slli = (r: number, s: number, n: number) => {
  const x = (32 - n) & 0x1f;
  return w(0, x & 0xf, s, r, 1, (x >> 4) & 1);
};
// SRAI dst, src, n: source is a[t], shift low nibble in s, hi bit in op2 (real assembler: srai a3,a5,8 = 0x213850).
const srai = (r: number, src: number, n: number) => w(0, src, n & 0xf, r, 1, 2 | ((n >> 4) & 1));
const srli = (r: number, src: number, n: number) => w(0, src, n & 0xf, r, 1, 4);
const srl = (r: number, src: number) => w(0, src, 0, r, 1, 9);
const sra = (r: number, src: number) => w(0, src, 0, r, 1, 0xb);
const ssai = (imm: number) => w(0, (imm >> 4) & 1, imm & 0xf, 4, 0, 4);
// mul (op1=2)
const mull = (r: number, s: number, t: number) => w(0, t, s, r, 2, 8);
const muluh = (r: number, s: number, t: number) => w(0, t, s, r, 2, 0xa);
const mulsh = (r: number, s: number, t: number) => w(0, t, s, r, 2, 0xb);
// integer divide/remainder (op1=2, op2=c..f)
// Real op2 (verified: quou a3,a5,a7 = 0xc23570 etc.): QUOU=0xc, QUOS=0xd, REMU=0xe, REMS=0xf (signed/unsigned
// are NOT swapped — the old encoder had them backwards, masking the interpreter's matching swap).
const quou = (r: number, s: number, t: number) => w(0, t, s, r, 2, 0xc);
const quos = (r: number, s: number, t: number) => w(0, t, s, r, 2, 0xd);
const remu = (r: number, s: number, t: number) => w(0, t, s, r, 2, 0xe);
const rems = (r: number, s: number, t: number) => w(0, t, s, r, 2, 0xf);
// MIN/MAX (op1=3, op2=4..7)
const min = (r: number, s: number, t: number) => w(0, t, s, r, 3, 4);
const max = (r: number, s: number, t: number) => w(0, t, s, r, 3, 5);
const minu = (r: number, s: number, t: number) => w(0, t, s, r, 3, 6);
const maxu = (r: number, s: number, t: number) => w(0, t, s, r, 3, 7);
// conditional moves (op1=3)
const moveqz = (r: number, s: number, t: number) => w(0, t, s, r, 3, 8);
const movnez = (r: number, s: number, t: number) => w(0, t, s, r, 3, 9);
const movltz = (r: number, s: number, t: number) => w(0, t, s, r, 3, 0xa);
const movgez = (r: number, s: number, t: number) => w(0, t, s, r, 3, 0xb);
// extui (op1=4/5): r=dst, src=a[t], shift, width(1..16)
const extui = (r: number, src: number, shift: number, width: number) =>
  w(0, src, shift & 0xf, r, 4 | ((shift >> 4) & 1), (width - 1) & 0xf);
// LSAI (op0=2)
const lsai = (op: number, t: number, s: number, imm8: number) =>
  w(2, t, s, op, imm8 & 0xf, (imm8 >> 4) & 0xf);
const movi = (t: number, v: number) => lsai(0xa, t, (v >> 8) & 0xf, v & 0xff);
const addi = (t: number, s: number, imm: number) => lsai(0xc, t, s, imm & 0xff);
const l8ui = (t: number, s: number, off: number) => lsai(0, t, s, off);
const s8i = (t: number, s: number, off: number) => lsai(4, t, s, off);
const l16ui = (t: number, s: number, off: number) => lsai(1, t, s, off);
const s16i = (t: number, s: number, off: number) => lsai(5, t, s, off);
const l16si = (t: number, s: number, off: number) => lsai(9, t, s, off);
const l32i = (t: number, s: number, off: number) => lsai(2, t, s, off);
const s32i = (t: number, s: number, off: number) => lsai(6, t, s, off);
// narrow
const l32in = (t: number, s: number, r: number) => n2(8, t, s, r);
const s32in = (t: number, s: number, r: number) => n2(9, t, s, r);
const addn = (r: number, s: number, t: number) => n2(0xa, t, s, r);
const addin = (r: number, s: number, t: number) => n2(0xb, t, s, r); // a[s] + (t==0 ? -1 : t)
const movin = (s: number, imm: number) => {
  const raw = imm < 0 ? imm + 128 : imm;
  return n2(0xc, (raw >> 4) & 0xf, s, raw & 0xf);
};
const movn = (t: number, s: number) => n2(0xd, t, s, 0);
const retn = () => n2(0xd, 0, 0, 0xf);
const nopn = () => n2(0xd, 1, 0, 0xf); // NOP.N (2-byte filler for call-target alignment)
// branches reg (op0=7): off relative to pc+4
const breg = (rsel: number, s: number, t: number, off: number) =>
  w(7, t, s, rsel, off & 0xf, (off >> 4) & 0xf);
const beq = (s: number, t: number, off: number) => breg(1, s, t, off);
const bne = (s: number, t: number, off: number) => breg(9, s, t, off);
const blt = (s: number, t: number, off: number) => breg(2, s, t, off);
const bltu = (s: number, t: number, off: number) => breg(3, s, t, off);
const bge = (s: number, t: number, off: number) => breg(0xa, s, t, off);
const bgeu = (s: number, t: number, off: number) => breg(0xb, s, t, off);
// branch zero (op0=6, n=1): off 12-bit
const bz = (m: number, s: number, off: number) =>
  w(6, (m << 2) | 1, s, off & 0xf, (off >> 4) & 0xf, (off >> 8) & 0xf);
const beqz = (s: number, off: number) => bz(0, s, off);
const bnez = (s: number, off: number) => bz(1, s, off);
const bltz = (s: number, off: number) => bz(2, s, off);
const bgez = (s: number, off: number) => bz(3, s, off);
// branch immediate / B4CONST (op0=6, n=2): r → B4CONST index, off 8-bit
const bi = (m: number, s: number, b4idx: number, off: number) =>
  w(6, (m << 2) | 2, s, b4idx, off & 0xf, (off >> 4) & 0xf);
const beqi = (s: number, b4idx: number, off: number) => bi(0, s, b4idx, off);
const blti = (s: number, b4idx: number, off: number) => bi(2, s, b4idx, off);
// call/jump — real Xtensa encodings: J is op0=6 (n=0); CALL0 is op0=5 (n=0). (The old codebase had these
// swapped — J at op0=5, CALL0 at op0=5 n=1 — which only worked because the call0 firmware uses CALLX0 +
// op0=6 J and never a direct op0=5 call. Verified against esp-clang/gcc -mabi=call0 output.)
const j5 = (off: number) => {
  const i = (6 | ((off & 0x3ffff) << 6)) >>> 0;
  return [i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff];
};
const call0 = (off: number) => {
  const i = (5 | ((off & 0x3ffff) << 6)) >>> 0;
  return [i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff];
};
const ret = () => [0x80, 0, 0];
const jx = (s: number) => [0xa0, s & 0xf, 0];
const callx0 = (s: number) => [0xc0, s & 0xf, 0];
// NSAU/NSA (op0=0, op1=0, op2=4 ST1 group; r selects, dst=a[t], src=a[s]). Count-leading-zeros family.
const nsau = (t: number, s: number) => w(0, t, s, 0xf, 0, 4);
const nsa = (t: number, s: number) => w(0, t, s, 0xe, 0, 4);
// LOOP/LOOPNEZ/LOOPGTZ (op0=6, n=3 m=1 → t=0x7; r=8/9/10; s=count; imm8 forward → LEND=pc+4+imm8).
const loopw = (rsel: number, s: number, off: number) =>
  w(6, 0x7, s, rsel, off & 0xf, (off >> 4) & 0xf);
const loop = (s: number, off: number) => loopw(8, s, off);
const loopnez = (s: number, off: number) => loopw(9, s, off);
const loopgtz = (s: number, off: number) => loopw(10, s, off);
// Audit-added decodes (all verified vs the real assembler):
// SEXT/CLAMPS (op1=3, op2=2/3): dst=a[r], src=a[s], bit b in the t field as t = imm-7 (imm 7..22).
const sext = (r: number, s: number, imm: number) => w(0, (imm - 7) & 0xf, s, r, 3, 2);
const clamps = (r: number, s: number, imm: number) => w(0, (imm - 7) & 0xf, s, r, 3, 3);
// MUL16U/MUL16S (op1=1, op2=c/d).
const mul16u = (r: number, s: number, t: number) => w(0, t, s, r, 1, 0xc);
const mul16s = (r: number, s: number, t: number) => w(0, t, s, r, 1, 0xd);
// RSR/WSR (op1=3, op2=0/1) + XSR (op1=1, op2=6): AR=a[t], SR# = (r<<4)|s.
const rsr = (t: number, sr: number) => w(0, t, sr & 0xf, (sr >> 4) & 0xf, 3, 0);
const wsr = (t: number, sr: number) => w(0, t, sr & 0xf, (sr >> 4) & 0xf, 3, 1);
const xsr = (t: number, sr: number) => w(0, t, sr & 0xf, (sr >> 4) & 0xf, 1, 6);
// S32C1I (LSAI r=0xe): data=a[t], base=a[s], offset = imm8<<2.
const s32c1i = (t: number, s: number, off: number) => lsai(0xe, t, s, off >> 2);
// EXCW — sync no-op that shares m=2 with RET (r=2 vs RET's r=0). Raw bytes (insn 0x002080).
const excw = (): number[] => [0x80, 0x20, 0x00];
const SCOMPARE1 = 12; // special-register number

// ── runner ──────────────────────────────────────────────────────────────────
function load(bytes: number[], ramSize = 0x8000): XtensaCpu {
  const bus = new SimpleBus(new Uint8Array(ramSize));
  bytes.forEach((b, i) => bus.write8(i, b));
  const cpu = new XtensaCpu(bus);
  cpu.pc = 0;
  return cpu;
}
function step(cpu: XtensaCpu, n: number): void {
  for (let i = 0; i < n; i++) cpu.step();
}

describe('xtensa — arithmetic & logic (QRST)', () => {
  it('ADD/SUB/ADDXn/SUBXn/AND/OR/XOR/NEG/ABS', () => {
    const cpu = load([
      ...add(3, 4, 5),
      ...sub(7, 4, 5),
      ...addx2(8, 4, 5),
      ...addx4(9, 4, 5),
      ...addx8(10, 4, 5),
      ...subx2(11, 4, 5),
      ...subx4(12, 4, 5),
      ...and(13, 4, 5),
      ...or(14, 4, 5),
      ...xor(15, 4, 5),
    ]);
    cpu.setReg(4, 10);
    cpu.setReg(5, 3);
    step(cpu, 10);
    expect(cpu.getReg(3)).toBe(13); // ADD
    expect(cpu.getReg(7)).toBe(7); // SUB
    expect(cpu.getReg(8)).toBe(23); // ADDX2 = (10<<1)+3
    expect(cpu.getReg(9)).toBe(43); // ADDX4 = (10<<2)+3
    expect(cpu.getReg(10)).toBe(83); // ADDX8 = (10<<3)+3
    expect(cpu.getReg(11)).toBe(17); // SUBX2 = (10<<1)-3
    expect(cpu.getReg(12)).toBe(37); // SUBX4 = (10<<2)-3
    expect(cpu.getReg(13)).toBe(2); // AND
    expect(cpu.getReg(14)).toBe(11); // OR
    expect(cpu.getReg(15)).toBe(9); // XOR
  });

  it('QUOS/QUOU/REMS/REMU — integer divide + remainder (emitted by any / or %)', () => {
    const cpu = load([
      ...quos(3, 4, 5),
      ...rems(6, 4, 5),
      ...quou(7, 8, 9),
      ...remu(10, 8, 9),
      ...quos(11, 4, 12),
    ]);
    cpu.setReg(4, -17);
    cpu.setReg(5, 5);
    cpu.setReg(8, 17);
    cpu.setReg(9, 5);
    cpu.setReg(12, 0); // divide-by-zero → defined result (0), no NaN/crash
    step(cpu, 5);
    expect(cpu.getReg(3)).toBe(-3); // QUOS: -17/5 truncates toward zero
    expect(cpu.getReg(6)).toBe(-2); // REMS: -17%5 = -2 (sign of dividend)
    expect(cpu.getReg(7)).toBe(3); // QUOU: 17/5 = 3
    expect(cpu.getReg(10)).toBe(2); // REMU: 17%5 = 2
    expect(cpu.getReg(11)).toBe(0); // QUOS by zero → 0 (sim-defined, never NaN)
  });

  it('MIN/MAX/MINU/MAXU (signed + unsigned), emitted by libc/libgcc', () => {
    const cpu = load([...min(3, 4, 5), ...max(6, 4, 5), ...minu(7, 4, 5), ...maxu(8, 4, 5)]);
    cpu.setReg(4, -2); // 0xfffffffe unsigned
    cpu.setReg(5, 7);
    step(cpu, 4);
    expect(cpu.getReg(3)).toBe(-2); // MIN signed: min(-2, 7)
    expect(cpu.getReg(6)).toBe(7); // MAX signed: max(-2, 7)
    expect(cpu.getReg(7)).toBe(7); // MINU unsigned: min(0xfffffffe, 7) = 7
    expect(cpu.getReg(8) >>> 0).toBe(0xfffffffe); // MAXU unsigned: max(0xfffffffe, 7)
  });

  it('NEG and ABS operate on a[t]', () => {
    const cpu = load([...neg(3, 4), ...abs(5, 4), ...abs(6, 7)]);
    cpu.setReg(4, -7);
    cpu.setReg(7, 9);
    step(cpu, 3);
    expect(cpu.getReg(3)).toBe(7); // NEG(-7)
    expect(cpu.getReg(5)).toBe(7); // ABS(-7)
    expect(cpu.getReg(6)).toBe(9); // ABS(9)
  });
});

describe('xtensa — shifts (SLLI/SRAI/SRLI/SRL/SRA via SAR)', () => {
  it('immediate and SAR-driven shifts respect sign', () => {
    const cpu = load([
      ...slli(3, 4, 4),
      ...srai(5, 4, 2),
      ...srli(6, 4, 2),
      ...ssai(2),
      ...srl(7, 4),
      ...sra(8, 4),
    ]);
    cpu.setReg(4, -16); // 0xfffffff0
    step(cpu, 6);
    expect(cpu.getReg(3) >>> 0).toBe(0xffffff00); // SLLI by 4
    expect(cpu.getReg(5)).toBe(-4); // SRAI arithmetic
    expect(cpu.getReg(6) >>> 0).toBe(0x3ffffffc); // SRLI logical
    expect(cpu.getReg(7) >>> 0).toBe(0x3ffffffc); // SRL (SAR=2) logical
    expect(cpu.getReg(8)).toBe(-4); // SRA (SAR=2) arithmetic
  });
  it('SRAI with shift > 15 and source != dest (real layout: src=a[t], sa low=s, hi=op2)', () => {
    // The exact regression from real libm fmodf: `srai a2, a11, 23` extracting a float exponent. The old
    // self-consistent decode used a[s] + the t field and returned 0 here (s≠t, shift uses the op2 hi bit).
    const cpu = load([...srai(2, 11, 23), ...srai(3, 4, 16)]);
    cpu.setReg(11, 0x40400000); // 3.0f bits → exponent field
    cpu.setReg(4, -1); // 0xffffffff
    step(cpu, 2);
    expect(cpu.getReg(2)).toBe(0x80); // 0x40400000 >> 23 (arithmetic) = 0x80, NOT 0
    expect(cpu.getReg(3)).toBe(-1); // -1 >> 16 (arithmetic) stays -1 (sign fill) — exercises the op2 hi bit
  });
});

describe('xtensa — multiply (MULL/MULUH/MULSH)', () => {
  it('low word and signed/unsigned high words', () => {
    const cpu = load([...mull(3, 4, 5), ...mulsh(6, 4, 5), ...muluh(7, 4, 5)]);
    cpu.setReg(4, -3); // 0xfffffffd
    cpu.setReg(5, 5);
    step(cpu, 3);
    expect(cpu.getReg(3)).toBe(-15); // MULL low 32
    expect(cpu.getReg(6)).toBe(-1); // MULSH: high of signed -15
    expect(cpu.getReg(7)).toBe(4); // MULUH: high of 0xfffffffd*5 unsigned
  });
});

describe('xtensa — conditional moves (MOVEQZ/MOVNEZ/MOVLTZ/MOVGEZ)', () => {
  it('move only when the condition on a[t] holds', () => {
    const cpu = load([
      ...moveqz(3, 4, 6),
      ...movnez(9, 5, 7),
      ...movltz(10, 4, 8),
      ...movgez(11, 5, 7),
      ...moveqz(12, 4, 7),
    ]);
    cpu.setReg(4, 111);
    cpu.setReg(5, 222);
    cpu.setReg(6, 0); // == 0 → MOVEQZ fires
    cpu.setReg(7, 5); // != 0
    cpu.setReg(8, -9); // < 0 → MOVLTZ fires
    cpu.setReg(12, 777); // MOVEQZ(…,a7=5) must NOT fire → stays 777
    step(cpu, 5);
    expect(cpu.getReg(3)).toBe(111); // MOVEQZ (a6==0)
    expect(cpu.getReg(9)).toBe(222); // MOVNEZ (a7!=0)
    expect(cpu.getReg(10)).toBe(111); // MOVLTZ (a8<0)
    expect(cpu.getReg(11)).toBe(222); // MOVGEZ (a7>=0)
    expect(cpu.getReg(12)).toBe(777); // unchanged (condition false)
  });
});

describe('xtensa — EXTUI bit-field extract', () => {
  it('extracts fields at width 4/8/16 (incl. the width-16 mask)', () => {
    const cpu = load([
      ...extui(3, 4, 0, 16),
      ...extui(5, 4, 16, 16),
      ...extui(6, 4, 4, 8),
      ...extui(7, 4, 8, 4),
    ]);
    cpu.setReg(4, 0xabcd1234 | 0);
    step(cpu, 4);
    expect(cpu.getReg(3) >>> 0).toBe(0x1234); // low halfword (width 16 must mask to 0xffff, not 0xffffffff)
    expect(cpu.getReg(5) >>> 0).toBe(0xabcd); // high halfword
    expect(cpu.getReg(6) >>> 0).toBe(0x23); // bits [11:4], width 8
    expect(cpu.getReg(7) >>> 0).toBe(0x2); // bits [11:8], width 4
  });
});

describe('xtensa — loads/stores (LSAI + narrow)', () => {
  it('L8UI/S8I/L16UI/S16I/L16SI/L32I/S32I round-trip with correct extension', () => {
    const cpu = load([
      ...s8i(4, 6, 0),
      ...l8ui(3, 6, 0), // store/load byte
      ...s16i(5, 6, 1),
      ...l16ui(7, 6, 1),
      ...l16si(8, 6, 1), // halfword (off*2 = addr 2)
      ...s32i(9, 6, 1),
      ...l32i(10, 6, 1), // word (off*4 = addr 4)
    ]);
    cpu.setReg(6, 0x400); // base
    cpu.setReg(4, 0xff); // byte value (no sign bit in L8UI)
    cpu.setReg(5, 0x8000); // halfword with sign bit
    cpu.setReg(9, 0x1234abcd | 0); // word
    step(cpu, 7);
    expect(cpu.getReg(3)).toBe(0xff); // L8UI zero-extends
    expect(cpu.getReg(7)).toBe(0x8000); // L16UI zero-extends
    expect(cpu.getReg(8)).toBe(-32768); // L16SI sign-extends 0x8000
    expect(cpu.getReg(10) >>> 0).toBe(0x1234abcd); // L32I
  });

  it('L32I.N/S32I.N and ADD.N/ADDI.N/MOV.N/MOVI.N', () => {
    const cpu = load([
      ...addn(3, 4, 5),
      ...addin(7, 4, 1),
      ...addin(8, 4, 0),
      ...movn(9, 4),
      ...movin(10, -5),
      ...movin(11, 95),
      ...s32in(4, 6, 0),
      ...l32in(12, 6, 0),
    ]);
    cpu.setReg(4, 10);
    cpu.setReg(5, 3);
    cpu.setReg(6, 0x500);
    step(cpu, 8);
    expect(cpu.getReg(3)).toBe(13); // ADD.N
    expect(cpu.getReg(7)).toBe(11); // ADDI.N +1
    expect(cpu.getReg(8)).toBe(9); // ADDI.N (t==0 → -1)
    expect(cpu.getReg(9)).toBe(10); // MOV.N
    expect(cpu.getReg(10)).toBe(-5); // MOVI.N negative
    expect(cpu.getReg(11)).toBe(95); // MOVI.N max positive
    expect(cpu.getReg(12)).toBe(10); // S32I.N then L32I.N round-trip
    expect(cpu.bus.read32(0x500)).toBe(10);
  });

  it('MOVI/ADDI sign-extend the immediate', () => {
    const cpu = load([...movi(3, -5), ...movi(4, 2000), ...addi(5, 4, -7)]);
    step(cpu, 3);
    expect(cpu.getReg(3)).toBe(-5);
    expect(cpu.getReg(4)).toBe(2000);
    expect(cpu.getReg(5)).toBe(1993); // 2000 + (-7)
  });
});

describe('xtensa — branches', () => {
  // [branch@0 (3B)] [movi a3,99 @3 (3B, "skipped")] [movi a3,1 @6 ("landing")]; off=2 → taken lands at 6.
  const runBranch = (branchBytes: number[], setup: (c: XtensaCpu) => void): number => {
    const cpu = load([...branchBytes, ...movi(3, 99), ...movi(3, 1)]);
    setup(cpu);
    step(cpu, 2); // branch, then exactly one movi
    return cpu.getReg(3);
  };

  it('BEQ/BNE register branches', () => {
    expect(
      runBranch(beq(4, 5, 2), (c) => {
        c.setReg(4, 7);
        c.setReg(5, 7);
      }),
    ).toBe(1); // taken
    expect(
      runBranch(beq(4, 5, 2), (c) => {
        c.setReg(4, 7);
        c.setReg(5, 8);
      }),
    ).toBe(99); // not taken
    expect(
      runBranch(bne(4, 5, 2), (c) => {
        c.setReg(4, 7);
        c.setReg(5, 8);
      }),
    ).toBe(1); // taken
  });

  it('BLT is signed, BLTU/BGEU are unsigned', () => {
    expect(
      runBranch(blt(4, 5, 2), (c) => {
        c.setReg(4, -1);
        c.setReg(5, 1);
      }),
    ).toBe(1); // -1 < 1 signed
    expect(
      runBranch(bltu(4, 5, 2), (c) => {
        c.setReg(4, -1);
        c.setReg(5, 1);
      }),
    ).toBe(99); // 0xffffffff < 1 unsigned: no
    expect(
      runBranch(bgeu(4, 5, 2), (c) => {
        c.setReg(4, -1);
        c.setReg(5, 1);
      }),
    ).toBe(1); // 0xffffffff >= 1 unsigned
    expect(
      runBranch(bge(4, 5, 2), (c) => {
        c.setReg(4, 5);
        c.setReg(5, 5);
      }),
    ).toBe(1); // 5 >= 5
  });

  it('BEQZ/BNEZ/BLTZ/BGEZ zero-compare branches', () => {
    expect(runBranch(beqz(4, 2), (c) => c.setReg(4, 0))).toBe(1);
    expect(runBranch(beqz(4, 2), (c) => c.setReg(4, 3))).toBe(99);
    expect(runBranch(bnez(4, 2), (c) => c.setReg(4, 3))).toBe(1);
    expect(runBranch(bltz(4, 2), (c) => c.setReg(4, -3))).toBe(1);
    expect(runBranch(bgez(4, 2), (c) => c.setReg(4, 0))).toBe(1);
  });

  it('BEQI/BLTI compare against B4CONST', () => {
    // B4CONST = [-1,1,2,3,4,5,6,7,8,10,12,16,32,64,128,256]; index 5 → 5, index 8 → 8
    expect(runBranch(beqi(4, 5, 2), (c) => c.setReg(4, 5))).toBe(1); // a4 == 5
    expect(runBranch(beqi(4, 5, 2), (c) => c.setReg(4, 6))).toBe(99); // a4 != 5
    expect(runBranch(blti(4, 8, 2), (c) => c.setReg(4, 3))).toBe(1); // 3 < 8
  });

  it('J jumps unconditionally', () => {
    const cpu = load([...j5(2), ...movi(3, 99), ...movi(3, 1)]);
    step(cpu, 2);
    expect(cpu.getReg(3)).toBe(1); // skipped the a3=99
  });
});

describe('xtensa — calls & returns (CALL0/CALLX0/RET/RET.N/JX)', () => {
  it('CALL0 sets a0 and RET.N returns to it', () => {
    // 0: call0(1)→pc=8,a0=3 | 3: movi a2,7 (post-return) | 6: nop.n filler | 8: movi a4,42 (callee) | 11: ret.n
    // call0 targets are word-aligned (4+(off<<2)); the filler pushes the callee onto offset 8.
    const cpu = load([...call0(1), ...movi(2, 7), ...nopn(), ...movi(4, 42), ...retn()]);
    step(cpu, 4); // call0, callee movi, ret.n, post-return movi
    expect(cpu.getReg(4)).toBe(42); // callee body ran
    expect(cpu.getReg(2)).toBe(7); // returned to the instruction after call0
    expect(cpu.getReg(0)).toBe(3); // a0 = return address
  });

  it('CALLX0 jumps to a register target and RET returns', () => {
    const cpu = load([...callx0(5), ...movi(2, 9), ...nopn(), ...movi(4, 55), ...ret()]);
    cpu.setReg(5, 8); // callee at 0x8 (after the nop.n filler)
    step(cpu, 4);
    expect(cpu.getReg(4)).toBe(55);
    expect(cpu.getReg(2)).toBe(9);
  });

  it('JX jumps to a register target', () => {
    const cpu = load([...jx(5), ...movi(3, 99), ...movi(3, 1)]);
    cpu.setReg(5, 6); // skip to the landing movi at 0x6
    step(cpu, 2);
    expect(cpu.getReg(3)).toBe(1);
  });
});

describe('xtensa — traps', () => {
  it('BREAK raises an XtensaTrap the host loop can catch', () => {
    const cpu = load([0x00, 0x40, 0x00]); // r=4 in ST0 → BREAK
    expect(() => cpu.step()).toThrow(XtensaTrap);
  });
});

// FP0 int<->float conversions (op0=0, op1=0xa). r=dst, s=src, t=power-of-2 scale (0 for a plain cast).
// FLOAT.S=0xc/UFLOAT.S=0xd/UTRUNC.S=0xe are clang-emitted + verified end-to-end in esp32-classic-fp.test.ts;
// FLOOR.S=0xa/CEIL.S=0xb are the standard adjacent encodings (clang uses libcalls for floorf/ceilf, so they
// can't be reached from C here) — this locks their decode semantics directly (xtensa-core audit).
const floorS = (r: number, s: number, t = 0) => w(0, t, s, r, 0xa, 0xa);
const ceilS = (r: number, s: number, t = 0) => w(0, t, s, r, 0xa, 0xb);
const ufloatS = (r: number, s: number, t = 0) => w(0, t, s, r, 0xa, 0xd);
const utruncS = (r: number, s: number, t = 0) => w(0, t, s, r, 0xa, 0xe);
// FP-division/sqrt OPTION (FP0 op2=0x6/0x7 + the t-dispatched seed sub-group under op2=0xf).
const maddnS = (r: number, s: number, t: number) => w(0, t, s, r, 0xa, 0x6); // NOP (option iteration)
const divnS = (r: number, s: number, t: number) => w(0, t, s, r, 0xa, 0x7); // NOP
const constS = (r: number, idx: number) => w(0, 0x3, idx, r, 0xa, 0xf); // f[r]=TABLE[idx]
const sqrt0S = (r: number, s: number) => w(0, 0x9, s, r, 0xa, 0xf); // NOP seed
const mksadjS = (r: number, s: number) => w(0, 0xc, s, r, 0xa, 0xf); // f[r]=sqrt(f[s])
const mkdadjS = (r: number, s: number) => w(0, 0xd, s, r, 0xa, 0xf); // f[r]=f[s]/f[r]
const addexpmS = (r: number, s: number) => w(0, 0xf, s, r, 0xa, 0xf); // move f[r]=f[s]
const movfS = (r: number, s: number, t: number) => w(0, t, s, r, 0xb, 0xc); // move if b[t]==0
const movtS = (r: number, s: number, t: number) => w(0, t, s, r, 0xb, 0xd); // move if b[t]==1

describe('xtensa — FP int<->float conversions (FP0, audit-added)', () => {
  it('FLOOR.S rounds a float toward -infinity into an AR', () => {
    const cpu = load([...floorS(2, 0), ...floorS(3, 1)]);
    cpu.setF(0, 3.7);
    cpu.setF(1, -2.3);
    step(cpu, 2);
    expect(cpu.getReg(2)).toBe(3); // floor(3.7)
    expect(cpu.getReg(3)).toBe(-3); // floor(-2.3)
  });

  it('CEIL.S rounds a float toward +infinity into an AR', () => {
    const cpu = load([...ceilS(2, 0), ...ceilS(3, 1)]);
    cpu.setF(0, 3.2);
    cpu.setF(1, -2.3);
    step(cpu, 2);
    expect(cpu.getReg(2)).toBe(4); // ceil(3.2)
    expect(cpu.getReg(3)).toBe(-2); // ceil(-2.3)
  });

  it('UFLOAT.S reads the source AR as UNSIGNED (0xFFFFFFFF → ~4.29e9, NOT -1.0)', () => {
    const cpu = load([...ufloatS(0, 4)]);
    cpu.setReg(4, -1); // bit pattern 0xFFFFFFFF
    step(cpu, 1);
    expect(cpu.getF(0)).toBeGreaterThan(4_000_000_000); // unsigned interpretation, not signed -1.0
  });

  it('UTRUNC.S truncates a float to an UNSIGNED int32', () => {
    const cpu = load([...utruncS(2, 0), ...utruncS(3, 1)]);
    cpu.setF(0, 7.9);
    cpu.setF(1, -5.0); // float→unsigned of a negative clamps to 0
    step(cpu, 2);
    expect(cpu.getReg(2)).toBe(7);
    expect(cpu.getReg(3)).toBe(0);
  });
});

describe('xtensa — NSAU / NSA (count leading zeros; used by libgcc 64-bit divide)', () => {
  it('NSAU = unsigned count-leading-zeros, 0 → 32', () => {
    const cpu = load([...nsau(5, 4)]);
    for (const [v, want] of [
      [3, 30],
      [1, 31],
      [0, 32],
      [0x40000000, 1],
      [-1, 0],
    ] as const) {
      cpu.pc = 0;
      cpu.setReg(4, v);
      step(cpu, 1);
      expect(cpu.getReg(5), `nsau(${v >>> 0})`).toBe(want);
    }
  });
  it('NSA = leading-sign-bit count − 1 (signed normalize)', () => {
    const cpu = load([...nsa(5, 4)]);
    for (const [v, want] of [
      [1, 30],
      [-1, 31],
      [0, 31],
      [-2, 30],
      [0x40000000, 0],
    ] as const) {
      cpu.pc = 0;
      cpu.setReg(4, v);
      step(cpu, 1);
      expect(cpu.getReg(5), `nsa(${v})`).toBe(want);
    }
  });
});

describe('xtensa — LOOP zero-overhead loop (LBEG/LEND/LCOUNT)', () => {
  // movi a2,N ; loop a2,END ; addi.n a3,a3,1 ; END: ret.n  — body (the addi.n) must run exactly N times.
  const prog = (enc: (s: number, off: number) => number[], n: number) =>
    load([...movi(2, n), ...enc(2, 1), ...addin(3, 3, 1), ...retn()]);

  it('LOOP runs the body exactly count times (fall-through to LEND loops back)', () => {
    const cpu = prog(loop, 3);
    cpu.setReg(3, 0);
    step(cpu, 5); // movi + loop + 3×body
    expect(cpu.getReg(3)).toBe(3);
  });
  it('a TAKEN branch to LEND does NOT loop back — only sequential fall-through does (strlen idiom)', () => {
    // The strlen pattern: the loop tail conditionally branches to LEND. When TAKEN it must run the handler
    // AT LEND (exit), NOT loop back; only a sequential fall-through to LEND loops. Layout:
    //   0: movi a2,5     ; large count (won't expire — the branch is what exits)
    //   3: movi a4,1     ; branch condition (truthy)
    //   6: loop a2,LEND  ; LEND = 14 (off=4)
    //   9: addi.n a3,a3,1; body
    //  11: bnez a4,LEND  ; taken → branch to 14 (== LEND == this insn's own seqPC)
    //  14: addi a3,a3,100; HANDLER at LEND (reached only by the taken branch)
    const cpu = load([
      ...movi(2, 5),
      ...movi(4, 1),
      ...loop(2, 4),
      ...addin(3, 3, 1),
      ...bnez(4, -1),
      ...addi(3, 3, 100),
      ...retn(),
    ]);
    cpu.setReg(3, 0);
    step(cpu, 6); // movi,movi,loop,addi.n(body once),bnez(taken→LEND),addi+100
    expect(cpu.getReg(3)).toBe(101); // body ran ONCE then the taken branch ran the handler — no spurious loop
  });
  it('LOOPNEZ with count 0 skips the body entirely', () => {
    const cpu = prog(loopnez, 0);
    cpu.setReg(3, 7);
    step(cpu, 3); // movi + loopnez(skip to LEND) + ret.n
    expect(cpu.getReg(3)).toBe(7); // body never ran
  });
  it('LOOPGTZ with a positive count runs the body', () => {
    const cpu = prog(loopgtz, 2);
    cpu.setReg(3, 0);
    step(cpu, 4); // movi + loopgtz + 2×body
    expect(cpu.getReg(3)).toBe(2);
  });
});

describe('xtensa — FP-division/sqrt option (QEMU model: seeds NOP, MKSADJ/MKDADJ do the real work)', () => {
  it('MKSADJ.S computes the real square root', () => {
    const cpu = load([...mksadjS(2, 1), ...mksadjS(4, 3)]);
    cpu.setF(1, 16);
    cpu.setF(3, 0.25);
    step(cpu, 2);
    expect(cpu.getF(2)).toBe(4); // sqrt(16)
    expect(cpu.getF(4)).toBe(0.5); // sqrt(0.25)
  });
  it('MKDADJ.S computes f[r] = f[s] / f[r] (inout denominator)', () => {
    const cpu = load([...mkdadjS(2, 1)]);
    cpu.setF(2, 2); // denominator (inout)
    cpu.setF(1, 7); // numerator (f[s])
    step(cpu, 1);
    expect(cpu.getF(2)).toBe(3.5); // 7 / 2
  });
  it('CONST.S loads the Tensilica FP immediate ROM {0.0, 1.0, 2.0, 0.5}', () => {
    const cpu = load([...constS(2, 0), ...constS(3, 1), ...constS(4, 2), ...constS(5, 3)]);
    step(cpu, 4);
    expect([cpu.getF(2), cpu.getF(3), cpu.getF(4), cpu.getF(5)]).toEqual([0, 1, 2, 0.5]);
  });
  it('MADDN.S / DIVN.S / SQRT0.S are no-ops (the schedule result comes from MKSADJ/ADDEXPM)', () => {
    const cpu = load([...maddnS(2, 1, 3), ...divnS(2, 1, 3), ...sqrt0S(2, 1)]);
    cpu.setF(2, 5); // accumulator/dst must be UNCHANGED by all three
    cpu.setF(1, 9);
    cpu.setF(3, 9);
    expect(() => step(cpu, 3)).not.toThrow(); // they decode (no XtensaTrap)...
    expect(cpu.getF(2)).toBe(5); // ...and leave the dst untouched
  });
  it('ADDEXPM.S moves f[s] into f[r] (carries the MKSADJ/MKDADJ result to the output reg)', () => {
    const cpu = load([...addexpmS(0, 2)]);
    cpu.setF(2, 3.5);
    cpu.setF(0, 0);
    step(cpu, 1);
    expect(cpu.getF(0)).toBe(3.5);
  });
  it('MOVF.S / MOVT.S move conditioned on a boolean register', () => {
    const cpu = load([...movfS(2, 1, 0), ...movtS(4, 3, 0)]);
    cpu.br = 0; // b0 = 0 → MOVF takes, MOVT skips
    cpu.setF(1, 7);
    cpu.setF(2, 1);
    cpu.setF(3, 9);
    cpu.setF(4, 2);
    step(cpu, 2);
    expect(cpu.getF(2)).toBe(7); // MOVF.S moved (b0==0)
    expect(cpu.getF(4)).toBe(2); // MOVT.S did NOT move (b0==0, needs 1)
  });
});

describe('xtensa — audit-found decodes (SEXT/CLAMPS/MUL16/RSR-WSR-XSR/S32C1I/EXCW)', () => {
  it('SEXT sign-extends a[s] from a configurable bit', () => {
    const cpu = load([...sext(3, 4, 7), ...sext(5, 6, 15)]);
    cpu.setReg(4, 0x80); // bit 7 set → sign-extend from bit 7 → 0xFFFFFF80
    cpu.setReg(6, 0x4000); // bit 14 set → sign-extend from bit 15 keeps it positive
    step(cpu, 2);
    expect(cpu.getReg(3) >>> 0).toBe(0xffffff80); // SEXT from bit 7
    expect(cpu.getReg(5)).toBe(0x4000); // SEXT from bit 15: bit 14 stays positive
  });
  it('CLAMPS saturates to a signed range', () => {
    const cpu = load([...clamps(3, 4, 7), ...clamps(5, 6, 7), ...clamps(7, 8, 7)]);
    cpu.setReg(4, 1000); // > 127 → clamp to 127
    cpu.setReg(6, -1000); // < -128 → clamp to -128
    cpu.setReg(8, 50); // in range → unchanged
    step(cpu, 3);
    expect(cpu.getReg(3)).toBe(127);
    expect(cpu.getReg(5)).toBe(-128);
    expect(cpu.getReg(7)).toBe(50);
  });
  it('MUL16U / MUL16S multiply the low halfwords', () => {
    const cpu = load([...mul16u(3, 4, 5), ...mul16s(6, 4, 5)]);
    cpu.setReg(4, 0x0001ffff); // low16 = 0xffff
    cpu.setReg(5, 0x00020002); // low16 = 0x0002
    step(cpu, 2);
    expect(cpu.getReg(3)).toBe(0xffff * 2); // MUL16U: 65535*2 = 131070
    expect(cpu.getReg(6)).toBe(-1 * 2); // MUL16S: (int16)0xffff = -1, *2 = -2
  });
  it('WSR/RSR/XSR round-trip a special register (SCOMPARE1)', () => {
    const cpu = load([
      ...wsr(4, SCOMPARE1),
      ...rsr(5, SCOMPARE1),
      ...xsr(6, SCOMPARE1),
      ...rsr(7, SCOMPARE1),
    ]);
    cpu.setReg(4, 0x1234);
    cpu.setReg(6, 0x9999); // XSR exchanges: SR was 0x1234, a6 becomes 0x1234, SR becomes 0x9999
    step(cpu, 4);
    expect(cpu.getReg(5)).toBe(0x1234); // RSR reads what WSR wrote
    expect(cpu.getReg(6)).toBe(0x1234); // XSR returned the old SR value
    expect(cpu.getReg(7)).toBe(0x9999); // ...and stored a6's old value
  });
  it('S32C1I does an atomic compare-and-swap against SCOMPARE1', () => {
    const cpu = load([...wsr(4, SCOMPARE1), ...s32c1i(5, 6, 0), ...s32c1i(7, 6, 0)]);
    cpu.bus.write32(0x200, 5); // memory holds 5
    cpu.setReg(4, 5); // SCOMPARE1 = 5 (matches)
    cpu.setReg(6, 0x200); // base address
    cpu.setReg(5, 99); // new value to store on match
    cpu.setReg(7, 42); // second CAS: SCOMPARE1 still 5 but memory is now 99 → mismatch
    step(cpu, 3);
    expect(cpu.bus.read32(0x200) >>> 0).toBe(99); // first CAS matched → stored 99
    expect(cpu.getReg(5)).toBe(5); // returned the old value
    expect(cpu.getReg(7)).toBe(99); // second CAS: returned current (99), did NOT store 42 (5 != 99)
  });
  it('EXCW is a sync no-op, NOT a RET (the r-field distinguishes it from RET at m=2)', () => {
    const cpu = load([...excw()]);
    cpu.setReg(0, 0xdeadbe); // a0 — RET would jump here; EXCW must NOT
    step(cpu, 1);
    expect(cpu.pc).toBe(3); // advanced past the 3-byte EXCW, did not jump to a0
  });
});
