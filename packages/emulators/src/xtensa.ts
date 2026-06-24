/**
 * Xtensa LX6 interpreter (ESP32 classic) — the WINDOWED register ABI (the real ESP32 default). Runs the
 * real compiled sketch/runtime + the windowed picolibc/libgcc multilib for the firmware-backed sim profile;
 * peripherals map onto the same MMIO bus (doctrine: API → HAL → MMIO).
 *
 * Implements the windowed register file (WindowBase rotation, ENTRY / CALL{4,8,12} / CALLX* / RETW), the
 * single-precision FPU incl. the FP-division/sqrt OPTION, the zero-overhead LOOP (LBEG/LEND/LCOUNT), and the
 * special/user registers (SAR, SCOMPARE1, FCR/FSR via RUR/WUR, RSR/WSR/XSR). CALL0 firmware also runs (the
 * windowed ops are simply never emitted). The register-window overflow/underflow SPILL is NOT modelled — a
 * large linear file holds deeply-nested frames instead; correct because GCC's variadic prologue stores its
 * own arg registers to the stack (no spill needed for va_arg) — the one place that would need spill,
 * setjmp/longjmp window-restore, is a documented best-effort.
 *
 * Every instruction encoding was VERIFIED against the real assembler (`xtensa-esp-elf-as` + the esp32
 * dynconfig), NOT a self-consistent unit-test encoder — that is how the SRAI / div-rem / J-CALL0 field/op2
 * swaps were caught. Instructions are little-endian byte streams, 16-bit (density) when op0 = byte0 & 0xf ∈
 * [8,13], else 24-bit. 24-bit RRR fields: op0=[3:0], t=[7:4], s=[11:8], r=[15:12], op1=[19:16] (RST group),
 * op2=[23:20] (op). Narrow RRRN fields: op0=[3:0], t=[7:4], s=[11:8], r=[15:12].
 */

import type { Rv32Bus } from './rv32.js';

export { SimpleBus } from './rv32.js'; // the MMIO bus is architecture-independent

export class XtensaTrap extends Error {
  constructor(
    public reason: string,
    public pc: number,
    public insn = 0,
  ) {
    super(`xtensa trap ${reason} @ 0x${(pc >>> 0).toString(16)} insn=0x${insn.toString(16)}`);
  }
}

const sext = (v: number, bits: number): number => (v << (32 - bits)) >> (32 - bits);

/** B4CONST table — the small constants the Bxxi (signed) instructions compare against. */
const B4CONST = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];
/** B4CONSTU — the unsigned variant for BLTUI/BGEUI (only entries 0,1 differ from B4CONST). */
const B4CONSTU = [32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];
/** CONST.S immediate ROM (raw IEEE-754 single bit patterns): 0.0, 1.0, 2.0, 0.5 — per Tensilica / QEMU. */
const FP_CONST = [0x00000000, 0x3f800000, 0x40000000, 0x3f000000];

/** Physical address-register file size for the WINDOWED ABI. Real LX6 has 64 (16 logical windows) +
 *  exception-driven spill; we use a larger linear file and never wrap, so register state is preserved
 *  across deep nesting WITHOUT emulating the overflow/underflow spill (transparent to correct code — the
 *  spill is an implementation detail of the hardware, not the ABI semantics). 512 = up to ~64 nested
 *  CALL8 frames, far beyond any libc call chain; deeper recursion traps honestly instead of corrupting. */
const WINDOW_REGS = 512;

export class XtensaCpu {
  // Physical AR file. Logical a[i] (i=0..15) = regs[windowReg + i]. In CALL0 firmware windowReg stays 0,
  // so a[i] == regs[i] exactly as before (the windowed instructions are simply never emitted).
  readonly regs = new Int32Array(WINDOW_REGS);
  /** WindowBase as a physical register offset (multiple of 4). CALLn adds n; RETW subtracts. */
  private windowReg = 0;
  /** WindowStart bitmask (live windows) — maintained for RSR/WSR fidelity; spill is not modelled. */
  private windowStart = 1;
  pc = 0;
  sar = 0;
  cycles = 0;
  /** when PC reaches this the run loop stops (return-to-host sentinel). */
  haltPc = 0xffffffff;
  // Single-precision FPU (ESP32 LX6). One backing buffer aliased as float (fr) and bits (fu) so FP
  // load/store moves raw 32-bit words while FP math sees IEEE-754 floats (Float32Array auto-rounds).
  private readonly fbuf = new ArrayBuffer(64);
  readonly fr = new Float32Array(this.fbuf); // f0..f15 as floats
  private readonly fu = new Uint32Array(this.fbuf); // same storage as bit patterns
  /** Boolean registers b0..b15 (1 bit each), set by FP compares + read by BT/BF. */
  br = 0;
  /** User (TIE) register file accessed by RUR/WUR — FCR (232)/FSR (233)/THREADPTR (231) live here. Not
   *  modelled architecturally (we round-to-nearest with no sticky flags); just stored/read back. */
  private readonly uregs = new Int32Array(256);
  /** SCOMPARE1 special register — the expected value for the S32C1I atomic compare-and-swap (single-core,
   *  so the CAS is non-atomic but correct). Set via WSR.SCOMPARE1 by picolibc's FILE-lock / once paths. */
  private scompare1 = 0;
  /** Generic special-register backing for the RSR/WSR/XSR numbers we don't map to a dedicated field
   *  (WINDOWBASE/WINDOWSTART are READ from the real window state below; writes land here — the no-spill
   *  window model means setjmp/longjmp window-restore is a documented best-effort, never a corruption). */
  private readonly sregs = new Int32Array(256);
  // Zero-overhead loop state (LBEG/LEND/LCOUNT special registers). Set by LOOP/LOOPNEZ/LOOPGTZ; the fetch
  // unit branches back to LBEG whenever the next PC reaches LEND and LCOUNT != 0. Real picolibc (strlen,
  // memcpy, vfprintf, …) relies on these — without them the loop body runs once and returns garbage.
  private lbeg = 0;
  private lend = 0;
  private lcount = 0; // kept unsigned (0..0xffffffff); LOOP with count 0 → 0xffffffff (breaks out internally)
  // True when the instruction just executed redirected control flow (branch/jump/call/return taken). The
  // loop-back only fires on SEQUENTIAL fall-through to LEND — a taken branch whose target happens to equal
  // LEND (the strlen loop-tail idiom) must NOT loop back. Distinguishing them needs this flag, because the
  // resulting PC value alone is identical in both cases.
  private branched = false;

  constructor(public bus: Rv32Bus) {}

  getReg(i: number): number {
    return this.regs[this.windowReg + (i & 15)]!;
  }
  setReg(i: number, v: number): void {
    this.regs[this.windowReg + (i & 15)] = v | 0;
  }
  /** Read a logical register `inc` windows (×4 regs) BELOW the current one — used by ENTRY to read the
   *  caller's stack pointer for the new frame (a[as] of the caller). */
  private getCallerReg(inc: number, i: number): number {
    return this.regs[(this.windowReg - inc * 4 + (i & 15)) | 0]!;
  }

  /** Special-register read (RSR/XSR) — the architectural ones map to dedicated fields; the rest are a
   *  generic store. SR numbers: LBEG=0, LEND=1, LCOUNT=2, SAR=3, SCOMPARE1=12, WINDOWBASE=72, WINDOWSTART=73. */
  private readSr(n: number): number {
    switch (n) {
      case 0:
        return this.lbeg | 0;
      case 1:
        return this.lend | 0;
      case 2:
        return this.lcount | 0;
      case 3:
        return this.sar | 0;
      case 12:
        return this.scompare1 | 0;
      case 72:
        return (this.windowReg >> 2) & 0xf; // WINDOWBASE — real window state
      case 73:
        return this.windowStart & 0xffff; // WINDOWSTART
      default:
        return this.sregs[n & 0xff]!;
    }
  }
  /** Special-register write (WSR/XSR). */
  private writeSr(n: number, v: number): void {
    switch (n) {
      case 0:
        this.lbeg = v >>> 0;
        return;
      case 1:
        this.lend = v >>> 0;
        return;
      case 2:
        this.lcount = v >>> 0;
        return;
      case 3:
        this.sar = v & 0x3f;
        return;
      case 12:
        this.scompare1 = v | 0;
        return;
      default:
        this.sregs[n & 0xff] = v | 0;
        return; // incl WINDOWBASE/WINDOWSTART (not applied to the linear file)
    }
  }

  /** A windowed CALL{4,8,12}/CALLX{4,8,12}: store the return address (with the window increment in its
   *  top 2 bits) into a[inc*4] of the CURRENT window — which becomes the callee's a0 after the rotation —
   *  then rotate the window forward by `inc` windows and jump. (CALLn does NOT itself check overflow; the
   *  large linear file means deep nesting just uses higher physical registers — no spill needed.) */
  private windowedCall(inc: number, target: number, retpc: number, pc: number): void {
    this.setReg(inc * 4, (inc << 30) | (retpc & 0x3fffffff) | 0); // link in caller's a[inc*4] = callee a0
    this.windowReg += inc * 4;
    if (this.windowReg + 16 > WINDOW_REGS)
      throw new XtensaTrap('windowed register file exhausted (recursion too deep)', pc, 0);
    this.windowStart |= 1 << ((this.windowReg >> 2) & 15);
    this.pc = target >>> 0;
    this.branched = true;
  }
  /** FP register as a float (for math). */
  getF(i: number): number {
    return this.fr[i & 15]!;
  }
  /** Set FP register from a float (stored as single-precision). */
  setF(i: number, v: number): void {
    this.fr[i & 15] = v;
  }
  /** FP register raw bits (for store / RFR). */
  getFbits(i: number): number {
    return this.fu[i & 15]! >>> 0;
  }
  /** Set FP register from raw bits (for load / WFR). */
  setFbits(i: number, bits: number): void {
    this.fu[i & 15] = bits >>> 0;
  }

  /** Debug ring of recent PCs (set XTENSA_TRACE=1) — to localise a control-flow desync. */
  readonly trace: number[] = [];
  private tracing = typeof process !== 'undefined' && process.env.XTENSA_TRACE === '1';

  step(): void {
    const pc = this.pc >>> 0;
    if (this.tracing) {
      this.trace.push(pc);
      if (this.trace.length > 4096) this.trace.shift();
    }
    const b0 = this.bus.read8(pc);
    const op0 = b0 & 0xf;
    const narrow = op0 >= 8 && op0 <= 13;
    const insn = narrow
      ? b0 | (this.bus.read8(pc + 1) << 8)
      : b0 | (this.bus.read8(pc + 1) << 8) | (this.bus.read8(pc + 2) << 16);
    this.pc = (pc + (narrow ? 2 : 3)) >>> 0;
    this.branched = false;
    if (narrow) this.execNarrow(insn, pc);
    else this.execWide(insn, op0, pc);
    // Zero-overhead loop-back: when an instruction FALLS THROUGH (no branch taken) to LEND and the loop is
    // unfinished, decrement LCOUNT and fetch from LBEG instead (exactly the HW fetch-unit check, which keys
    // off the next SEQUENTIAL PC — not branch targets).
    if (!this.branched && this.pc >>> 0 === this.lend && this.lcount !== 0) {
      this.lcount = (this.lcount - 1) >>> 0;
      this.pc = this.lbeg >>> 0;
    }
    this.cycles++;
  }

  run(max: number): number {
    let n = 0;
    for (; n < max && this.pc >>> 0 !== this.haltPc >>> 0; n++) this.step();
    return n;
  }

  private execWide(insn: number, op0: number, pc: number): void {
    const t = (insn >> 4) & 0xf;
    const s = (insn >> 8) & 0xf;
    const r = (insn >> 12) & 0xf;
    switch (op0) {
      case 0x0:
        return this.execQRST(insn, pc, t, s, r);
      case 0x1: {
        // L32R — load PC-relative literal (negative word offset)
        const imm16 = (insn >> 8) & 0xffff;
        const addr = (((pc + 3) & ~3) + (sext(imm16, 16) << 2)) >>> 0;
        this.setReg(t, this.bus.read32(addr) | 0);
        return;
      }
      case 0x2: {
        // LSAI — load/store + ADDI/ADDMI; R selects the op, t=data, s=base, imm8.
        const imm8 = (insn >> 16) & 0xff;
        const base = this.getReg(s);
        switch (r) {
          case 0x0:
            this.setReg(t, this.bus.read8((base + imm8) >>> 0) & 0xff);
            return; // L8UI
          case 0x1:
            this.setReg(t, this.bus.read16((base + (imm8 << 1)) >>> 0) & 0xffff);
            return; // L16UI
          case 0x2:
            this.setReg(t, this.bus.read32((base + (imm8 << 2)) >>> 0) | 0);
            return; // L32I
          case 0x4:
            this.bus.write8((base + imm8) >>> 0, this.getReg(t) & 0xff);
            return; // S8I
          case 0x5:
            this.bus.write16((base + (imm8 << 1)) >>> 0, this.getReg(t) & 0xffff);
            return; // S16I
          case 0x6:
            this.bus.write32((base + (imm8 << 2)) >>> 0, this.getReg(t) >>> 0);
            return; // S32I
          case 0x9:
            this.setReg(t, sext(this.bus.read16((base + (imm8 << 1)) >>> 0), 16));
            return; // L16SI
          case 0xa: {
            // MOVI — imm12 = sext({s, imm8})
            const imm12 = sext((s << 8) | imm8, 12);
            this.setReg(t, imm12);
            return;
          }
          case 0xb:
            return; // CACHE/MEMW family in LSAI sub-encodings — no-op
          case 0xc:
            this.setReg(t, (base + sext(imm8, 8)) | 0);
            return; // ADDI
          case 0xd:
            this.setReg(t, (base + (sext(imm8, 8) << 8)) | 0);
            return; // ADDMI
          case 0xe: {
            // S32C1I — atomic compare-and-swap (single-core: read; if == SCOMPARE1 store a[t]; return old)
            const a = (base + (imm8 << 2)) >>> 0;
            const old = this.bus.read32(a) | 0;
            if (old >>> 0 === this.scompare1 >>> 0) this.bus.write32(a, this.getReg(t) >>> 0);
            this.setReg(t, old);
            return;
          }
          default:
            throw new XtensaTrap(`LSAI r=${r}`, pc, insn);
        }
      }
      case 0x3: {
        // LSCI — single-precision FP load/store. r selects; t=FP reg, s=base AR, imm8 (word offset).
        const imm8 = (insn >> 16) & 0xff;
        const base = this.getReg(s);
        const off = imm8 << 2;
        switch (r) {
          case 0x0:
            this.setFbits(t, this.bus.read32((base + off) >>> 0));
            return; // LSI
          case 0x4:
            this.bus.write32((base + off) >>> 0, this.getFbits(t));
            return; // SSI
          case 0x8: {
            const a = (base + off) >>> 0;
            this.setReg(s, a);
            this.setFbits(t, this.bus.read32(a));
            return;
          } // LSIU
          case 0xc: {
            const a = (base + off) >>> 0;
            this.setReg(s, a);
            this.bus.write32(a, this.getFbits(t));
            return;
          } // SSIU
          default:
            throw new XtensaTrap(`LSCI r=${r}`, pc, insn);
        }
      }
      case 0x5: {
        // CALL family (op0=5). n=insn[5:4]: 0 → CALL0 (flat ABI); 1/2/3 → CALL4/8/12 (windowed). The plain
        // unconditional jump `j` is op0=6, NOT here. Targets are word-aligned: ((pc+4)&~3)+(off<<2).
        const n = (insn >> 4) & 0x3;
        const off = sext(insn >> 6, 18);
        const target = (((pc + 4) & ~3) + (off << 2)) >>> 0;
        if (n === 0) {
          this.setReg(0, this.pc | 0); // CALL0: a0 = return addr; pc = target
          this.pc = target;
          this.branched = true;
          return;
        }
        this.windowedCall(n, target, this.pc, pc); // CALL4 (n=1) / CALL8 (n=2) / CALL12 (n=3)
        return;
      }
      case 0x6:
        return this.execBranchImm(insn, pc, s, r);
      case 0x7:
        return this.execBranchReg(insn, pc, t, s, r);
      default:
        throw new XtensaTrap(`wide op0=${op0}`, pc, insn);
    }
  }

  /** op0=0 — QRST. op1=insn[19:16] (RST group), op2=insn[23:20] (op). */
  private execQRST(insn: number, pc: number, t: number, s: number, r: number): void {
    const op1 = (insn >> 16) & 0xf;
    const op2 = (insn >> 20) & 0xf;
    const as = this.getReg(s);
    const at = this.getReg(t);
    if (op1 === 0x0) {
      // RST0
      switch (op2) {
        case 0x0:
          return this.execST0(insn, pc, t, s); // CALLX/JR/RET group + others
        case 0x1:
          this.setReg(r, as & at);
          return; // AND
        case 0x2:
          this.setReg(r, as | at);
          return; // OR
        case 0x3:
          this.setReg(r, as ^ at);
          return; // XOR
        case 0x4: // ST1 group — set-SAR + normalize-count (r selects; NSA/NSAU write a[t], not SAR)
          if (r === 0)
            this.sar = as & 0x1f; // SSR
          else if (r === 1)
            this.sar = (32 - (as & 0x1f)) & 0x3f; // SSL
          else if (r === 2)
            this.sar = (as & 0x3) << 3; // SSA8L
          else if (r === 3)
            this.sar = 32 - ((as & 0x3) << 3); // SSA8B
          else if (r === 4)
            this.sar = (((insn >> 8) & 0xf) | (((insn >> 4) & 1) << 4)) & 0x3f; // SSAI
          // NSAU at,as = count leading zeros of a[s] (0..32); NSA = leading-sign-bit count − 1 (0..31).
          // Used by libgcc's 64-bit divide (__udivdi3/__umoddi3) to normalize the divisor — without it,
          // multi-digit integer printf (%d via __ultoa_invert) produces garbage. dst = a[t], src = a[s].
          else if (r === 0xf)
            this.setReg(t, Math.clz32(as >>> 0)); // NSAU
          else if (r === 0xe)
            this.setReg(t, ((as | 0) >= 0 ? Math.clz32(as >>> 0) : Math.clz32(~as >>> 0)) - 1); // NSA
          return;
        case 0x6: // RT0: NEG (s-field selects NEG/ABS)
          this.setReg(r, s === 0 ? -at | 0 : Math.abs(at) | 0);
          return;
        case 0x8:
          this.setReg(r, (as + at) | 0);
          return; // ADD
        case 0x9:
          this.setReg(r, ((as << 1) + at) | 0);
          return; // ADDX2 = (a[s]<<1)+a[t]
        case 0xa:
          this.setReg(r, ((as << 2) + at) | 0);
          return; // ADDX4
        case 0xb:
          this.setReg(r, ((as << 3) + at) | 0);
          return; // ADDX8
        case 0xc:
          this.setReg(r, (as - at) | 0);
          return; // SUB
        case 0xd:
          this.setReg(r, ((as << 1) - at) | 0);
          return; // SUBX2
        case 0xe:
          this.setReg(r, ((as << 2) - at) | 0);
          return; // SUBX4
        case 0xf:
          this.setReg(r, ((as << 3) - at) | 0);
          return; // SUBX8
      }
    } else if (op1 === 0x1) {
      // RST1 — shifts. op2 selects (all verified from esp-clang/gcc output).
      switch (op2) {
        case 0x0:
        case 0x1: {
          // SLLI — sa = 32 - ((op2bit0<<4) | t); src = a[s]
          const sa = (32 - ((((insn >> 20) & 1) << 4) | t)) & 0x1f;
          this.setReg(r, as << sa);
          return;
        }
        case 0x2:
        case 0x3: {
          // SRAI — sa = (op2bit0<<4) | s ; src = a[t]. (Field layout is the MIRROR of
          // SLLI: the source is a[t] and the shift's low nibble is the s field — verified against the real
          // assembler: `srai a3,a5,8` = 0x213850 (t=5=src, s=8=sa), `srai a2,a11,23` = 0x3127b0. The old
          // decode used a[s]/t and only ever ran on s==t shifts until real libm code (fmodf) hit s≠t.)
          const sa = ((((insn >> 20) & 1) << 4) | s) & 0x1f;
          this.setReg(r, at >> sa);
          return;
        }
        case 0x4:
        case 0x5: // SRLI — sa = s; src = a[t]   (verified: srli a3,a4,3 = 0x413340)
          this.setReg(r, at >>> (s & 0x1f));
          return;
        case 0x8: {
          // SRC — funnel (a[s]:a[t]) >> SAR. At SAR=0 the result is the LOW word a[t] (NOT a[s]).
          const sa = this.sar & 0x3f;
          const hi = as >>> 0;
          const lo = at >>> 0;
          const v =
            sa === 0
              ? lo
              : sa < 32
                ? ((hi << (32 - sa)) | (lo >>> sa)) >>> 0
                : (hi >>> (sa - 32)) >>> 0;
          this.setReg(r, v | 0);
          return;
        }
        case 0x9:
          this.setReg(r, at >>> (this.sar & 0x1f));
          return; // SRL — src a[t]
        case 0xa:
          this.setReg(r, as << ((32 - this.sar) & 0x1f));
          return; // SLL — src a[s], shift 32-SAR
        case 0xb:
          this.setReg(r, at >> (this.sar & 0x1f));
          return; // SRA — src a[t]
        case 0x6: {
          // XSR — exchange a[t] with special-register (r<<4)|s (atomically). Encoded in RST1, not RST3.
          const sr = ((r << 4) | s) & 0xff;
          const old = this.readSr(sr);
          this.writeSr(sr, this.getReg(t));
          this.setReg(t, old);
          return;
        }
        // MUL16U/MUL16S (op2=0xc/0xd) — 16×16→32 multiply of the LOW halfwords (unsigned / signed). Emitted
        // by libc (snprintf/vfprintf) and integer code; the full product fits in 32 bits so Math.imul is exact.
        case 0xc:
          this.setReg(r, Math.imul(as & 0xffff, at & 0xffff));
          return; // MUL16U
        case 0xd:
          this.setReg(r, Math.imul((as << 16) >> 16, (at << 16) >> 16));
          return; // MUL16S
      }
    } else if (op1 === 0x2) {
      // RST2 — MUL (op2 8..b) + DIV/REM (op2 c..f, the 32-bit integer divide option). The compiler emits
      // these for any `/` or `%` in a sketch, so they're common. Divide-by-zero raises an exception on
      // real hardware; the sim returns a defined value (0 / the dividend) so the interpreter never NaNs.
      switch (op2) {
        case 0x8:
          this.setReg(r, Math.imul(as, at));
          return; // MULL
        case 0xa:
          this.setReg(r, mulhu(as, at));
          return; // MULUH
        case 0xb:
          this.setReg(r, mulhs(as, at));
          return; // MULSH
        // Verified against the real assembler: op2=0xc=QUOU(unsigned), 0xd=QUOS(signed), 0xe=REMU(unsigned),
        // 0xf=REMS(signed). (The previous decode had signed/unsigned SWAPPED — masked by a self-consistent
        // unit-test encoder — so every `int -7/2` returned the unsigned result. Audit-found, runtime-proven.)
        case 0xc:
          this.setReg(r, at === 0 ? 0 : ((as >>> 0) / (at >>> 0)) >>> 0);
          return; // QUOU (unsigned quotient)
        case 0xd:
          this.setReg(r, at === 0 ? 0 : (as / at) | 0);
          return; // QUOS (signed quotient)
        case 0xe:
          this.setReg(r, at === 0 ? as : ((as >>> 0) % (at >>> 0)) >>> 0);
          return; // REMU (unsigned remainder)
        case 0xf:
          this.setReg(r, at === 0 ? as : (as % at) | 0);
          return; // REMS (signed remainder)
      }
    } else if (op1 === 0x3) {
      // RST3 — special/user-register access, sign-extend/clamp, MIN/MAX, and conditional moves. All verified
      // against the real assembler (the AR is the t field for RSR/WSR/XSR; SR/UR numbers split across r:s/s:t).
      const sext_imm = ((insn >> 4) & 0xf) + 7; // SEXT/CLAMPS bit position b (7..22); t-field + 7
      switch (op2) {
        case 0x0:
          this.setReg(t, this.readSr(((r << 4) | s) & 0xff));
          return; // RSR  a[t] = SR[(r<<4)|s]
        case 0x1:
          this.writeSr(((r << 4) | s) & 0xff, this.getReg(t));
          return; // WSR  SR[(r<<4)|s] = a[t]
        case 0x2:
          this.setReg(r, sext(as, sext_imm + 1));
          return; // SEXT a[r] = sign-extend a[s] from bit b (keep b+1 low bits)
        case 0x3: {
          // CLAMPS a[r] = clamp a[s] to the signed range [-2^b, 2^b - 1]
          const hi = (1 << sext_imm) - 1,
            lo = -(1 << sext_imm);
          this.setReg(r, as > hi ? hi : as < lo ? lo : as);
          return;
        }
        case 0x4:
          this.setReg(r, as < at ? as : at);
          return; // MIN
        case 0x5:
          this.setReg(r, as > at ? as : at);
          return; // MAX
        case 0x6:
          this.setReg(r, as >>> 0 < at >>> 0 ? as : at);
          return; // MINU
        case 0x7:
          this.setReg(r, as >>> 0 > at >>> 0 ? as : at);
          return; // MAXU
        case 0x8:
          if (at === 0) this.setReg(r, as);
          return; // MOVEQZ
        case 0x9:
          if (at !== 0) this.setReg(r, as);
          return; // MOVNEZ
        case 0xa:
          if (at < 0) this.setReg(r, as);
          return; // MOVLTZ
        case 0xb:
          if (at >= 0) this.setReg(r, as);
          return; // MOVGEZ
        // MOVF/MOVT a[r], a[s], b[t] — move a[s]→a[r] when boolean b[t] is 0 / 1 (set by an FP compare).
        case 0xc:
          if (((this.br >> t) & 1) === 0) this.setReg(r, as);
          return; // MOVF
        case 0xd:
          if (((this.br >> t) & 1) === 1) this.setReg(r, as);
          return; // MOVT
        // RUR/WUR — user (TIE) register file. NOTE the asymmetric field layout: RUR number = (s<<4)|t, dst =
        // a[r]; WUR number = (r<<4)|s, src = a[t]. FCR=232/FSR=233/THREADPTR=231 live here (scratch — we
        // round-to-nearest with no sticky flags, so they're just stored/read back).
        case 0xe:
          this.setReg(r, this.uregs[((s << 4) | t) & 0xff]!);
          return; // RUR
        case 0xf:
          this.uregs[((r << 4) | s) & 0xff] = this.getReg(t) | 0;
          return; // WUR
      }
    } else if (op1 === 0x4 || op1 === 0x5) {
      // EXTUI r, a[t], shift, width — extract an unsigned bit field (verified:
      // extui a3,a4,5,8 = 0x743540 → dst r=a3, src a[t]=a4, shift=5, width=op2+1=8).
      const shift = (((insn >> 16) & 1) << 4) | s;
      const mask = ((1 << (op2 + 1)) - 1) >>> 0; // width = op2+1 (1..16); op2=15 → 0xffff
      this.setReg(r, (at >>> shift) & mask);
      return;
    } else if (op1 === 0xa) {
      // FP0 — single-precision arithmetic + int<->float conversion. r/s/t index FP regs; the conversions
      // use an AR (a[s]/a[r]) and the `t` field as a power-of-two scale (t=0 for a plain cast). The op2
      // values for THIS toolchain (esp-clang) were VERIFIED by probing real compiler output — notably
      // FLOAT.S is op2=0xc here (some references list 0xa). Unconfirmed op2s fall through to a trap
      // (surfaced honestly) rather than guess a possibly-wrong decode.
      const fs = this.getF(s);
      const ft = this.getF(t);
      switch (op2) {
        case 0x0:
          this.setF(r, fs + ft);
          return; // ADD.S
        case 0x1:
          this.setF(r, fs - ft);
          return; // SUB.S
        case 0x2:
          this.setF(r, fs * ft);
          return; // MUL.S
        case 0x4:
          this.setF(r, this.getF(r) + fs * ft);
          return; // MADD.S
        case 0x5:
          this.setF(r, this.getF(r) - fs * ft);
          return; // MSUB.S
        // MADDN.S (0x6) / DIVN.S (0x7) — the Newton-iteration / final-step ops of the LX6 FP-division &
        // square-root OPTION. They appear ONLY inside libgcc's __divsf3/__ieee754_sqrtf/__recipsf2/
        // __rsqrtsf2 macro-sequences. We model that option exactly as QEMU does: the seed + iteration ops
        // (DIV0/RECIP0/SQRT0/RSQRT0/NEXP01/MADDN/DIVN/ADDEXP) are NO-OPS and the TRUE result is produced by
        // MKSADJ.S/MKDADJ.S (real sqrt/divide), then carried to the output by ADDEXPM.S (a move). So the
        // fixed gcc schedule still yields the correctly-rounded IEEE result. (Normal a*b+c uses MADD.S 0x4.)
        case 0x6:
          return; // MADDN.S — NOP (handled by MKSADJ/MKDADJ + ADDEXPM)
        case 0x7:
          return; // DIVN.S — NOP
        case 0x8:
          this.setReg(r, roundEvenI32(fs * Math.pow(2, t)));
          return; // ROUND.S (float→int, round-even)
        case 0x9:
          this.setReg(r, clampI32(Math.trunc(fs * Math.pow(2, t))));
          return; // TRUNC.S (float→int, verified)
        // FLOOR.S / CEIL.S — float→signed-int rounding toward -∞ / +∞. clang emits these for floorf()/ceilf()
        // and some (int) casts; without them the firmware HALTED on a normal sketch (xtensa-core audit).
        case 0xa:
          this.setReg(r, clampI32(Math.floor(fs * Math.pow(2, t))));
          return; // FLOOR.S
        case 0xb:
          this.setReg(r, clampI32(Math.ceil(fs * Math.pow(2, t))));
          return; // CEIL.S
        case 0xc:
          this.setF(r, as / Math.pow(2, t));
          return; // FLOAT.S: f[r] = a[s] / 2^t (signed int→float, verified)
        // UFLOAT.S — UNSIGNED int→float (a[s] read as uint32); emitted for `(float)unsignedValue` (e.g.
        // analogRead()/millis() in float math). UTRUNC.S — float→UNSIGNED int, truncate toward zero.
        case 0xd:
          this.setF(r, (as >>> 0) / Math.pow(2, t));
          return; // UFLOAT.S
        case 0xe: {
          const u = Math.trunc(fs * Math.pow(2, t));
          this.setReg(r, u <= 0 ? 0 : u >= 0xffffffff ? 0xffffffff : u); // clamp to uint32; setReg's |0 keeps the bit pattern
          return; // UTRUNC.S
        }
        case 0xf: // FP1OP — unary FP ops + the division/sqrt seed sub-group, dispatched by the t field
          if (t === 0x0) {
            this.setF(r, this.getF(s));
            return;
          } // MOV.S
          if (t === 0x1) {
            this.setF(r, Math.abs(this.getF(s)));
            return;
          } // ABS.S
          // CONST.S — load an FP immediate from the Tensilica const ROM (index = the s field). Table verified
          // against QEMU translate_const_s: {0.0, 1.0, 2.0, 0.5}. Stored as raw bits (it IS a bit pattern).
          if (t === 0x3) {
            this.setFbits(r, FP_CONST[s & 0x3]!);
            return;
          } // CONST.S
          if (t === 0x4) {
            this.setReg(r, this.getFbits(s));
            return;
          } // RFR: a[r] = bits(f[s])
          if (t === 0x5) {
            this.setFbits(r, this.getReg(s) >>> 0);
            return;
          } // WFR: f[r] = bits(a[s])
          if (t === 0x6) {
            this.setF(r, -this.getF(s));
            return;
          } // NEG.S
          // Division/sqrt OPTION (see MADDN/DIVN note above). Seeds + exponent-normalize are NO-OPS; the real
          // value is computed by MKSADJ.S (sqrt) / MKDADJ.S (divide, f[r]=f[s]/f[r]) and moved out by ADDEXPM.
          if (t === 0x7 || t === 0x8 || t === 0x9 || t === 0xa || t === 0xb || t === 0xe) return; // DIV0/RECIP0/SQRT0/RSQRT0/NEXP01/ADDEXP — NOP
          if (t === 0xc) {
            this.setF(r, Math.sqrt(this.getF(s)));
            return;
          } // MKSADJ.S: f[r] = sqrt(f[s])
          if (t === 0xd) {
            this.setF(r, this.getF(s) / this.getF(r));
            return;
          } // MKDADJ.S: f[r] = f[s] / f[r]
          if (t === 0xf) {
            this.setFbits(r, this.getFbits(s));
            return;
          } // ADDEXPM.S — raw move f[r] = f[s]
          break;
      }
    } else if (op1 === 0xb) {
      // FP1 — FP compares set boolean reg b[r] (read later by BT/BF); conditional FP moves on an AR test.
      const fs = this.getF(s);
      const ft = this.getF(t);
      const setB = (cond: boolean) => {
        if (cond) this.br |= 1 << r;
        else this.br &= ~(1 << r);
      };
      switch (op2) {
        case 0x1:
          setB(Number.isNaN(fs) || Number.isNaN(ft));
          return; // UN.S (unordered)
        case 0x2:
          setB(fs === ft);
          return; // OEQ.S
        case 0x3:
          setB(Number.isNaN(fs) || Number.isNaN(ft) || fs === ft);
          return; // UEQ.S
        case 0x4:
          setB(fs < ft);
          return; // OLT.S
        case 0x5:
          setB(Number.isNaN(fs) || Number.isNaN(ft) || fs < ft);
          return; // ULT.S
        case 0x6:
          setB(fs <= ft);
          return; // OLE.S
        case 0x7:
          setB(Number.isNaN(fs) || Number.isNaN(ft) || fs <= ft);
          return; // ULE.S
        case 0x8:
          if (at === 0) this.setF(r, fs);
          return; // MOVEQZ.S
        case 0x9:
          if (at !== 0) this.setF(r, fs);
          return; // MOVNEZ.S
        case 0xa:
          if (at < 0) this.setF(r, fs);
          return; // MOVLTZ.S
        case 0xb:
          if (at >= 0) this.setF(r, fs);
          return; // MOVGEZ.S
        // MOVF.S / MOVT.S — move f[s]→f[r] conditioned on boolean reg b[t] (set by an FP compare), not an AR.
        case 0xc:
          if (((this.br >> t) & 1) === 0) this.setF(r, fs);
          return; // MOVF.S
        case 0xd:
          if (((this.br >> t) & 1) === 1) this.setF(r, fs);
          return; // MOVT.S
      }
    }
    throw new XtensaTrap(`QRST op1=${op1} op2=${op2}`, pc, insn);
  }

  /**
   * op0=0, op1=0, op2=0 — ST0 minor. The flat-ABI subset: CALLX0 / JX / RET (jx a0). The rest
   * of ST0 here (MEMW / EXTW / ISYNC / DSYNC / ESYNC / RSYNC / NOP) are barriers/no-ops in this
   * in-order model. m=insn[7:6], n=insn[5:4], r=insn[15:12] distinguishes CALLX0 (r=0) from the
   * syncs (e.g. MEMW has r=2). Decoding verified against esp-clang output.
   */
  private execST0(insn: number, pc: number, t: number, s: number): void {
    const m = (insn >> 6) & 0x3;
    const n = (insn >> 4) & 0x3;
    const r = (insn >> 12) & 0xf;
    // RET/RETW/JX live at m=2 ONLY with r=0; the same m=2 with r=2 is EXCW (a sync no-op) — without the r
    // guard, EXCW was executed as RET (pc ← a0, corrupting control flow).
    if (m === 0x2 && r === 0) {
      if (n === 1) {
        // RETW — windowed return: read the link a0 (top 2 bits = the window increment), rotate the
        // window back, and jump to the reconstructed PC (its top 2 bits come from the RETW's own PC).
        const a0 = this.getReg(0) >>> 0;
        this.windowReg -= ((a0 >>> 30) & 0x3) * 4;
        this.pc = ((pc & 0xc0000000) | (a0 & 0x3fffffff)) >>> 0;
        this.branched = true;
        return;
      }
      // n=0 RET (pc=a0, call0), n=2 JX (pc=a[s])
      this.pc = (n === 2 ? this.getReg(s) : this.getReg(0)) >>> 0;
      this.branched = true;
      return;
    }
    if (m === 0x3 && r === 0) {
      const target = this.getReg(s) >>> 0; // a[s] read in the CURRENT (caller) window, before any rotation
      if (n === 0) {
        // CALLX0 (call0 indirect): a0 = return addr; pc = a[s]
        this.setReg(0, this.pc | 0);
        this.pc = target;
        this.branched = true;
        return;
      }
      this.windowedCall(n, target, this.pc, pc); // CALLX4 (n=1) / CALLX8 (n=2) / CALLX12 (n=3)
      return;
    }
    if (r === 0x4) throw new XtensaTrap('break', pc, insn); // BREAK (incl __builtin_trap)
    void t;
    // MEMW / syncs / NOP / SNM0 — no architectural effect in the sim.
  }

  /** op0=6 — branch-immediate family + ENTRY. n=insn[5:4]: 0=J, 1=BZ, 2=BI, 3=B*UI/ENTRY. */
  private execBranchImm(insn: number, pc: number, s: number, r: number): void {
    const n = (insn >> 4) & 0x3;
    if (n === 0) {
      const off = sext(insn >> 6, 18);
      this.pc = (pc + 4 + off) >>> 0;
      this.branched = true; // J
      return;
    }
    const m = (insn >> 6) & 0x3;
    if (n === 3 && m === 0) {
      // ENTRY as, imm — windowed prologue. The window was already rotated by the caller's CALLn; the
      // increment is in a0's top 2 bits. The new frame SP = caller's a[as] - framesize (imm12 * 8).
      const inc = (this.getReg(0) >>> 30) & 0x3;
      const frame = ((insn >> 12) & 0xfff) << 3;
      this.setReg(s, (this.getCallerReg(inc, s) - frame) | 0);
      this.windowStart |= 1 << ((this.windowReg >> 2) & 15);
      return;
    }
    const a = this.getReg(s);
    if (n === 1) {
      // BZ: m 0=BEQZ,1=BNEZ,2=BLTZ,3=BGEZ ; off = sext(insn[23:12],12)
      const off = sext(insn >> 12, 12);
      const take = m === 0 ? a === 0 : m === 1 ? a !== 0 : m === 2 ? a < 0 : a >= 0;
      if (take) {
        this.pc = (pc + 4 + off) >>> 0;
        this.branched = true;
      }
      return;
    }
    if (n === 2) {
      // BI: m 0=BEQI,1=BNEI,2=BLTI,3=BGEI ; r→B4CONST, off=sext(insn[23:16],8)
      const b = B4CONST[r]!;
      const off = sext(insn >> 16, 8);
      const take = m === 0 ? a === b : m === 1 ? a !== b : m === 2 ? a < b : a >= b;
      if (take) {
        this.pc = (pc + 4 + off) >>> 0;
        this.branched = true;
      }
      return;
    }
    if (n === 3 && (m === 2 || m === 3)) {
      // BLTUI (m=2) / BGEUI (m=3): unsigned compare against B4CONSTU[r]; off=sext(insn[23:16],8).
      // Emitted by unsigned arithmetic (e.g. Print::print(unsigned) digit loop) — common in real sketches.
      const b = B4CONSTU[r]! >>> 0;
      const off = sext(insn >> 16, 8);
      const take = m === 2 ? a >>> 0 < b : a >>> 0 >= b;
      if (take) {
        this.pc = (pc + 4 + off) >>> 0;
        this.branched = true;
      }
      return;
    }
    if (n === 3 && m === 1) {
      // B1 group — r selects: 0=BF, 1=BT (boolean-reg branch); 8/9/10=LOOP/LOOPNEZ/LOOPGTZ.
      if (r === 8 || r === 9 || r === 10) {
        // Zero-overhead loop setup. LBEG = next insn (this.pc), LEND = pc + 4 + imm8 (UNSIGNED, forward).
        const cnt = this.getReg(s);
        this.lbeg = this.pc >>> 0;
        this.lend = (pc + 4 + ((insn >> 16) & 0xff)) >>> 0;
        const skip = r === 9 ? cnt === 0 : r === 10 ? cnt <= 0 : false; // LOOPNEZ / LOOPGTZ guard
        if (skip) {
          this.lcount = 0;
          this.pc = this.lend;
          this.branched = true;
        } // body runs 0 times
        else this.lcount = (cnt - 1) >>> 0; // LOOP, or taken NEZ/GTZ: body runs `cnt` times
        return;
      }
      // BF (r=0) / BT (r=1): branch on boolean reg b[s] (set by an FP compare); off=sext(insn[23:16],8).
      const bit = (this.br >> s) & 1;
      const off = sext(insn >> 16, 8);
      const take = r === 0 ? bit === 0 : bit === 1;
      if (take) {
        this.pc = (pc + 4 + off) >>> 0;
        this.branched = true;
      }
      return;
    }
    throw new XtensaTrap(`BranchImm n=${n} m=${m} r=${r}`, pc, insn);
  }

  /** op0=7 — register-register branches. r selects; off = sext(insn[23:16],8). */
  private execBranchReg(insn: number, pc: number, t: number, s: number, r: number): void {
    const off = sext(insn >> 16, 8);
    const a = this.getReg(s);
    const b = this.getReg(t);
    // BBCI/BBSI take an IMMEDIATE bit number: bbi = (r&1)<<4 | t (0..31). BBC/BBS take it from a[t]&31.
    const immBit = (((r & 1) << 4) | t) & 31;
    let take = false;
    switch (r) {
      case 0x0:
        take = (a & b) === 0;
        break; // BNONE — branch if no bits of b set in a
      case 0x1:
        take = a === b;
        break; // BEQ
      case 0x2:
        take = a < b;
        break; // BLT
      case 0x3:
        take = a >>> 0 < b >>> 0;
        break; // BLTU
      case 0x4:
        take = (a & b) === b;
        break; // BALL — all bits of b set in a
      case 0x5:
        take = ((a >> (b & 31)) & 1) === 0;
        break; // BBC — bit a[t]&31 of a[s] clear
      case 0x6:
      case 0x7:
        take = ((a >> immBit) & 1) === 0;
        break; // BBCI — immediate bit clear
      case 0x8:
        take = (a & b) !== 0;
        break; // BANY — any bit of b set in a
      case 0x9:
        take = a !== b;
        break; // BNE
      case 0xa:
        take = a >= b;
        break; // BGE
      case 0xb:
        take = a >>> 0 >= b >>> 0;
        break; // BGEU
      case 0xc:
        take = (a & b) !== b;
        break; // BNALL — not all bits of b set in a
      case 0xd:
        take = ((a >> (b & 31)) & 1) === 1;
        break; // BBS — bit a[t]&31 of a[s] set
      case 0xe:
      case 0xf:
        take = ((a >> immBit) & 1) === 1;
        break; // BBSI — immediate bit set
      default:
        throw new XtensaTrap(`BranchReg r=${r}`, pc, insn);
    }
    if (take) {
      this.pc = (pc + 4 + off) >>> 0;
      this.branched = true;
    }
  }

  /** 16-bit density instructions. RRRN fields: r=insn[15:12], s=insn[11:8], t=insn[7:4]. */
  private execNarrow(insn: number, pc: number): void {
    const op0 = insn & 0xf;
    const t = (insn >> 4) & 0xf;
    const s = (insn >> 8) & 0xf;
    const r = (insn >> 12) & 0xf;
    switch (op0) {
      case 0x8:
        this.setReg(t, this.bus.read32((this.getReg(s) + (r << 2)) >>> 0) | 0);
        return; // L32I.N
      case 0x9:
        this.bus.write32((this.getReg(s) + (r << 2)) >>> 0, this.getReg(t) >>> 0);
        return; // S32I.N
      case 0xa:
        this.setReg(r, (this.getReg(s) + this.getReg(t)) | 0);
        return; // ADD.N
      case 0xb:
        this.setReg(r, (this.getReg(s) + (t === 0 ? -1 : t)) | 0);
        return; // ADDI.N
      case 0xc: {
        // ST2: MOVI.N (z=0) / BEQZ.N,BNEZ.N (z=1, by insn[7])
        if ((insn & 0x80) === 0) {
          let imm = (((insn >> 4) & 0xf) << 4) | ((insn >> 12) & 0xf); // imm7 = (t<<4)|r
          if (imm >= 96) imm -= 128; // range -32..95
          this.setReg(s, imm); // dst = s
          return;
        }
        // BEQZ.N / BNEZ.N : reg s; forward off imm6 = (insn[5:4] << 4) | insn[15:12]; cond by insn[6].
        // (The high 2 bits come from insn[5:4] — NOT insn[9:8], which overlaps the register field s; that
        // long-standing decode bug only surfaced once real picolibc code used a >16 offset — xtensa audit.)
        const off = (((insn >> 4) & 0x3) << 4) | ((insn >> 12) & 0xf);
        const a = this.getReg(s);
        const take = ((insn >> 6) & 1) === 0 ? a === 0 : a !== 0;
        if (take) {
          this.pc = (pc + 4 + off) >>> 0;
          this.branched = true;
        }
        return;
      }
      case 0xd: {
        // ST3: r selects — 0=MOV.N (dst=t, src=s), 0xf=RET.N/NOP.N (by t)
        if (r === 0x0) {
          this.setReg(t, this.getReg(s)); // MOV.N
          return;
        }
        if (r === 0xf) {
          if (t === 0) {
            this.pc = this.getReg(0) >>> 0;
            this.branched = true; // RET.N (call0)
            return;
          }
          if (t === 1) {
            // RETW.N — narrow windowed return (same semantics as RETW).
            const a0 = this.getReg(0) >>> 0;
            this.windowReg -= ((a0 >>> 30) & 0x3) * 4;
            this.pc = ((pc & 0xc0000000) | (a0 & 0x3fffffff)) >>> 0;
            this.branched = true;
            return;
          }
          return; // NOP.N / BREAK.N — no-op
        }
        throw new XtensaTrap(`ST3 r=${r}`, pc, insn);
      }
      default:
        throw new XtensaTrap(`narrow op0=${op0}`, pc, insn);
    }
  }
}

function mulhu(a: number, b: number): number {
  return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n) | 0;
}
function mulhs(a: number, b: number): number {
  return Number((BigInt(a) * BigInt(b)) >> 32n) | 0;
}
/** Saturating float→int32 (Xtensa TRUNC/ROUND clamp on overflow; NaN → 0). */
function clampI32(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return x | 0;
}
/** Round half-to-even (IEEE default, Xtensa ROUND.S), then saturate to int32. */
function roundEvenI32(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  const r = diff < 0.5 ? f : diff > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
  return clampI32(r);
}
