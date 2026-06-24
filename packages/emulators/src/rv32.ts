/**
 * rv32imc — a small, exact RISC-V interpreter (RV32I + M + C) for the ESP32-C3 (Stage 4).
 * This is the CPU core of the *firmware-backed* C3 simulation: it executes the real compiled
 * sketch/IDF instructions. Peripherals (GPIO, UART, timers) are layered on as MMIO via the Bus
 * (doctrine: API → HAL → MMIO — the CPU is the base, devices map onto its address space).
 *
 * 32-bit integer discipline: JS numbers are f64, so every arithmetic result is normalised back
 * to 32 bits — `| 0` for a signed view, `>>> 0` for unsigned. Registers are stored raw in an
 * Int32Array (x0 is hardwired to 0). The C (compressed) extension is handled by expanding each
 * 16-bit instruction to its 32-bit equivalent, then reusing the single 32-bit execute path.
 */

export interface Rv32Bus {
  read8(addr: number): number;
  read16(addr: number): number;
  read32(addr: number): number;
  write8(addr: number, v: number): void;
  write16(addr: number, v: number): void;
  write32(addr: number, v: number): void;
}

/** Flat little-endian RAM with optional MMIO regions, addressable across the 32-bit space. */
export class SimpleBus implements Rv32Bus {
  private regions: { base: number; size: number; dev: Partial<Rv32Bus> }[] = [];
  constructor(public ram = new Uint8Array(0)) {}

  /** Map a device (peripheral) over [base, base+size). Device methods take ABSOLUTE addresses. */
  map(base: number, size: number, dev: Partial<Rv32Bus>): void {
    this.regions.push({ base, size, dev });
  }
  private dev(addr: number): { base: number; dev: Partial<Rv32Bus> } | undefined {
    for (const r of this.regions) if (addr >= r.base && addr < r.base + r.size) return r;
    return undefined;
  }

  read8(a: number): number {
    const r = this.dev(a >>> 0);
    if (r?.dev.read8) return r.dev.read8(a >>> 0) & 0xff;
    return this.ram[a >>> 0] ?? 0;
  }
  read16(a: number): number {
    const r = this.dev(a >>> 0);
    if (r?.dev.read16) return r.dev.read16(a >>> 0) & 0xffff;
    return (this.read8(a) | (this.read8(a + 1) << 8)) & 0xffff;
  }
  read32(a: number): number {
    const r = this.dev(a >>> 0);
    if (r?.dev.read32) return r.dev.read32(a >>> 0) >>> 0;
    return (
      (this.read8(a) |
        (this.read8(a + 1) << 8) |
        (this.read8(a + 2) << 16) |
        (this.read8(a + 3) << 24)) >>>
      0
    );
  }
  write8(a: number, v: number): void {
    const r = this.dev(a >>> 0);
    if (r?.dev.write8) return r.dev.write8(a >>> 0, v & 0xff);
    this.ram[a >>> 0] = v & 0xff;
  }
  write16(a: number, v: number): void {
    const r = this.dev(a >>> 0);
    if (r?.dev.write16) return r.dev.write16(a >>> 0, v & 0xffff);
    this.write8(a, v & 0xff);
    this.write8(a + 1, (v >>> 8) & 0xff);
  }
  write32(a: number, v: number): void {
    const r = this.dev(a >>> 0);
    if (r?.dev.write32) return r.dev.write32(a >>> 0, v >>> 0);
    this.write8(a, v & 0xff);
    this.write8(a + 1, (v >>> 8) & 0xff);
    this.write8(a + 2, (v >>> 16) & 0xff);
    this.write8(a + 3, (v >>> 24) & 0xff);
  }
}

/** Raised on ECALL/EBREAK or a fault so the host loop can decide what to do (e.g. ROM trap). */
export class Rv32Trap extends Error {
  constructor(
    public override cause: number, // overrides Error.cause (ES2022); narrowed to the mcause code
    public pc: number,
    public tval = 0,
  ) {
    super(`rv32 trap cause=${cause} pc=0x${(pc >>> 0).toString(16)}`);
  }
}
export const CAUSE_ECALL_M = 11;
export const CAUSE_BREAKPOINT = 3;
export const CAUSE_ILLEGAL = 2;

const signExtend = (v: number, bits: number): number => (v << (32 - bits)) >> (32 - bits);

export class Rv32Cpu {
  /** x0..x31 (x0 reads as 0). Stored signed; callers use getReg/setReg. */
  readonly regs = new Int32Array(32);
  pc = 0;
  /** retired-instruction counter (rough virtual cycles; the kernel owns real virtual time). */
  cycles = 0;
  /** minimal machine CSRs (enough for trap vectoring + FreeRTOS bring-up later). */
  csr: Record<number, number> = { 0x300: 0, 0x305: 0, 0x341: 0, 0x342: 0, 0x304: 0, 0x344: 0 };

  constructor(public bus: Rv32Bus) {}

  getReg(i: number): number {
    return i === 0 ? 0 : this.regs[i]!;
  }
  setReg(i: number, v: number): void {
    if (i !== 0) this.regs[i] = v | 0;
  }

  /** Fetch + execute one instruction (16- or 32-bit). Throws Rv32Trap on ECALL/EBREAK/illegal. */
  step(): void {
    const pc = this.pc >>> 0;
    const lo = this.bus.read16(pc);
    let insn: number;
    let len: number;
    if ((lo & 3) === 3) {
      insn = (lo | (this.bus.read16(pc + 2) << 16)) >>> 0; // 32-bit
      len = 4;
    } else {
      insn = this.decompress(lo, pc); // expand 16-bit → 32-bit equivalent
      len = 2;
    }
    this.pc = (pc + len) >>> 0;
    this.execute(insn, pc);
    this.cycles++;
  }

  /** Run up to `max` instructions; returns the count actually retired (stops early on trap). */
  run(max: number): number {
    let n = 0;
    for (; n < max; n++) this.step();
    return n;
  }

  private execute(insn: number, pc: number): void {
    const op = insn & 0x7f;
    const rd = (insn >>> 7) & 0x1f;
    const f3 = (insn >>> 12) & 7;
    const rs1 = (insn >>> 15) & 0x1f;
    const rs2 = (insn >>> 20) & 0x1f;
    const f7 = (insn >>> 25) & 0x7f;
    const a = this.getReg(rs1);
    const b = this.getReg(rs2);

    switch (op) {
      case 0x37: // LUI
        this.setReg(rd, insn & 0xfffff000);
        return;
      case 0x17: // AUIPC
        this.setReg(rd, (pc + (insn & 0xfffff000)) | 0);
        return;
      case 0x6f: {
        // JAL
        const imm =
          ((insn >> 31) << 20) |
          (((insn >> 21) & 0x3ff) << 1) |
          (((insn >> 20) & 1) << 11) |
          (((insn >> 12) & 0xff) << 12);
        this.setReg(rd, this.pc | 0); // this.pc == pc+len (return address); set before overwriting
        this.pc = (pc + signExtend(imm >>> 0, 21)) >>> 0;
        return;
      }
      case 0x67: {
        // JALR
        const imm = signExtend(insn >> 20, 12);
        const target = (a + imm) & ~1;
        this.setReg(rd, this.pc | 0); // return addr (pc advanced)
        this.pc = target >>> 0;
        return;
      }
      case 0x63: {
        // BRANCH
        const imm =
          (((insn >> 31) & 1) << 12) |
          (((insn >> 7) & 1) << 11) |
          (((insn >> 25) & 0x3f) << 5) |
          (((insn >> 8) & 0xf) << 1);
        const off = signExtend(imm, 13);
        let take = false;
        switch (f3) {
          case 0:
            take = a === b;
            break; // BEQ
          case 1:
            take = a !== b;
            break; // BNE
          case 4:
            take = a < b;
            break; // BLT
          case 5:
            take = a >= b;
            break; // BGE
          case 6:
            take = a >>> 0 < b >>> 0;
            break; // BLTU
          case 7:
            take = a >>> 0 >= b >>> 0;
            break; // BGEU
          default:
            throw new Rv32Trap(CAUSE_ILLEGAL, pc, insn);
        }
        if (take) this.pc = (pc + off) >>> 0;
        return;
      }
      case 0x03: {
        // LOAD
        const imm = signExtend(insn >> 20, 12);
        const addr = (a + imm) >>> 0;
        switch (f3) {
          case 0:
            this.setReg(rd, signExtend(this.bus.read8(addr), 8));
            return; // LB
          case 1:
            this.setReg(rd, signExtend(this.bus.read16(addr), 16));
            return; // LH
          case 2:
            this.setReg(rd, this.bus.read32(addr) | 0);
            return; // LW
          case 4:
            this.setReg(rd, this.bus.read8(addr) & 0xff);
            return; // LBU
          case 5:
            this.setReg(rd, this.bus.read16(addr) & 0xffff);
            return; // LHU
          default:
            throw new Rv32Trap(CAUSE_ILLEGAL, pc, insn);
        }
      }
      case 0x23: {
        // STORE
        const imm = signExtend((((insn >> 25) & 0x7f) << 5) | ((insn >> 7) & 0x1f), 12);
        const addr = (a + imm) >>> 0;
        switch (f3) {
          case 0:
            this.bus.write8(addr, b & 0xff);
            return; // SB
          case 1:
            this.bus.write16(addr, b & 0xffff);
            return; // SH
          case 2:
            this.bus.write32(addr, b >>> 0);
            return; // SW
          default:
            throw new Rv32Trap(CAUSE_ILLEGAL, pc, insn);
        }
      }
      case 0x13: {
        // OP-IMM
        const imm = signExtend(insn >> 20, 12);
        const shamt = (insn >> 20) & 0x1f;
        switch (f3) {
          case 0:
            this.setReg(rd, (a + imm) | 0);
            return; // ADDI
          case 2:
            this.setReg(rd, a < imm ? 1 : 0);
            return; // SLTI
          case 3:
            this.setReg(rd, a >>> 0 < imm >>> 0 ? 1 : 0);
            return; // SLTIU
          case 4:
            this.setReg(rd, a ^ imm);
            return; // XORI
          case 6:
            this.setReg(rd, a | imm);
            return; // ORI
          case 7:
            this.setReg(rd, a & imm);
            return; // ANDI
          case 1:
            this.setReg(rd, a << shamt);
            return; // SLLI
          case 5:
            this.setReg(rd, f7 & 0x20 ? a >> shamt : a >>> shamt); // SRAI : SRLI
            return;
          default:
            throw new Rv32Trap(CAUSE_ILLEGAL, pc, insn);
        }
      }
      case 0x33: {
        // OP (RV32I + M)
        if (f7 === 1) return this.executeM(rd, f3, a, b, pc, insn); // M extension
        switch (f3) {
          case 0:
            this.setReg(rd, f7 & 0x20 ? (a - b) | 0 : (a + b) | 0);
            return; // SUB : ADD
          case 1:
            this.setReg(rd, a << (b & 0x1f));
            return; // SLL
          case 2:
            this.setReg(rd, a < b ? 1 : 0);
            return; // SLT
          case 3:
            this.setReg(rd, a >>> 0 < b >>> 0 ? 1 : 0);
            return; // SLTU
          case 4:
            this.setReg(rd, a ^ b);
            return; // XOR
          case 5:
            this.setReg(rd, f7 & 0x20 ? a >> (b & 0x1f) : a >>> (b & 0x1f));
            return; // SRA : SRL
          case 6:
            this.setReg(rd, a | b);
            return; // OR
          case 7:
            this.setReg(rd, a & b);
            return; // AND
          default:
            throw new Rv32Trap(CAUSE_ILLEGAL, pc, insn);
        }
      }
      case 0x0f: // FENCE / FENCE.I — no reordering in this in-order interpreter
        return;
      case 0x73: {
        // SYSTEM
        if (f3 === 0) {
          const imm = (insn >>> 20) & 0xfff;
          if (imm === 0) throw new Rv32Trap(CAUSE_ECALL_M, pc); // ECALL
          if (imm === 1) throw new Rv32Trap(CAUSE_BREAKPOINT, pc); // EBREAK
          if (imm === 0x302) {
            // MRET → resume from mepc
            this.pc = this.csr[0x341]! >>> 0;
            return;
          }
          return; // WFI / other privileged — treat as nop
        }
        // Zicsr: CSRRW/S/C (+ immediate forms)
        const csrAddr = (insn >>> 20) & 0xfff;
        const old = this.csr[csrAddr] ?? 0;
        const src = f3 & 4 ? rs1 : this.getReg(rs1); // immediate forms use rs1 field as zimm
        switch (f3 & 3) {
          case 1:
            this.csr[csrAddr] = src | 0;
            break; // CSRRW
          case 2:
            if (rs1 !== 0) this.csr[csrAddr] = old | src;
            break; // CSRRS
          case 3:
            if (rs1 !== 0) this.csr[csrAddr] = old & ~src;
            break; // CSRRC
        }
        this.setReg(rd, old | 0);
        return;
      }
      default:
        throw new Rv32Trap(CAUSE_ILLEGAL, pc, insn);
    }
  }

  private executeM(rd: number, f3: number, a: number, b: number, pc: number, insn: number): void {
    switch (f3) {
      case 0: // MUL (low 32)
        this.setReg(rd, Math.imul(a, b));
        return;
      case 1:
        this.setReg(rd, mulh(a, b, true, true));
        return; // MULH (signed×signed)
      case 2:
        this.setReg(rd, mulh(a, b, true, false));
        return; // MULHSU
      case 3:
        this.setReg(rd, mulh(a, b, false, false));
        return; // MULHU
      case 4: // DIV
        this.setReg(rd, b === 0 ? -1 : a === -0x80000000 && b === -1 ? -0x80000000 : (a / b) | 0);
        return;
      case 5: // DIVU
        this.setReg(rd, b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0);
        return;
      case 6: // REM
        this.setReg(rd, b === 0 ? a : a === -0x80000000 && b === -1 ? 0 : (a % b) | 0);
        return;
      case 7: // REMU
        this.setReg(rd, b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0);
        return;
      default:
        throw new Rv32Trap(CAUSE_ILLEGAL, pc, insn);
    }
  }

  /**
   * Expand one 16-bit compressed instruction to its 32-bit equivalent (RVC quadrants 0/1/2).
   * Covers the integer subset rv32imc firmware actually emits. Unknown encodings trap.
   */
  private decompress(c: number, pc: number): number {
    const op = c & 3;
    const f3 = (c >>> 13) & 7;
    const rdFull = (c >>> 7) & 0x1f;
    const rs2Full = (c >>> 2) & 0x1f;
    const rdC = 8 + ((c >>> 2) & 7); // x8..x15 (rd'/rs2')
    const rs1C = 8 + ((c >>> 7) & 7); // x8..x15 (rs1'/rd')
    const encI = (rd: number, f: number, r1: number, imm: number) =>
      (((imm & 0xfff) << 20) | (r1 << 15) | (f << 12) | (rd << 7) | 0x13) >>> 0;
    const encR = (rd: number, f: number, r1: number, r2: number, f7: number) =>
      ((f7 << 25) | (r2 << 20) | (r1 << 15) | (f << 12) | (rd << 7) | 0x33) >>> 0;

    if (op === 0) {
      switch (f3) {
        case 0: {
          // C.ADDI4SPN → addi rd', x2, nzuimm
          const imm =
            (((c >> 7) & 0xf) << 6) |
            (((c >> 11) & 3) << 4) |
            (((c >> 5) & 1) << 3) |
            (((c >> 6) & 1) << 2);
          if (imm === 0) break;
          return encI(rdC, 0, 2, imm);
        }
        case 2: {
          // C.LW → lw rd', off(rs1')
          const imm = (((c >> 5) & 1) << 6) | (((c >> 10) & 7) << 3) | (((c >> 6) & 1) << 2);
          return (((imm & 0xfff) << 20) | (rs1C << 15) | (2 << 12) | (rdC << 7) | 0x03) >>> 0;
        }
        case 6: {
          // C.SW → sw rs2', off(rs1')
          const imm = (((c >> 5) & 1) << 6) | (((c >> 10) & 7) << 3) | (((c >> 6) & 1) << 2);
          const immHi = (imm >> 5) & 0x7f;
          const immLo = imm & 0x1f;
          return (
            ((immHi << 25) | (rdC << 20) | (rs1C << 15) | (2 << 12) | (immLo << 7) | 0x23) >>> 0
          );
        }
      }
    } else if (op === 1) {
      switch (f3) {
        case 0: {
          // C.ADDI / C.NOP → addi rd, rd, nzimm
          const imm = signExtend((((c >> 12) & 1) << 5) | rs2Full, 6);
          return encI(rdFull, 0, rdFull, imm);
        }
        case 1: {
          // C.JAL → jal x1, off
          return this.encJ(1, c, pc);
        }
        case 2: {
          // C.LI → addi rd, x0, imm
          const imm = signExtend((((c >> 12) & 1) << 5) | rs2Full, 6);
          return encI(rdFull, 0, 0, imm);
        }
        case 3: {
          if (rdFull === 2) {
            // C.ADDI16SP → addi x2, x2, nzimm
            const imm = signExtend(
              (((c >> 12) & 1) << 9) |
                (((c >> 3) & 3) << 7) |
                (((c >> 5) & 1) << 6) |
                (((c >> 2) & 1) << 5) |
                (((c >> 6) & 1) << 4),
              10,
            );
            return encI(2, 0, 2, imm);
          }
          // C.LUI → lui rd, nzimm
          const imm = (signExtend((((c >> 12) & 1) << 5) | rs2Full, 6) << 12) >>> 0;
          return ((imm & 0xfffff000) | (rdFull << 7) | 0x37) >>> 0;
        }
        case 4: {
          // MISC-ALU (CB/CA)
          const sub = (c >> 10) & 3;
          const shamt = (((c >> 12) & 1) << 5) | rs2Full;
          if (sub === 0) return encI(rs1C, 5, rs1C, shamt & 0x1f); // C.SRLI → srli
          if (sub === 1) return encI(rs1C, 5, rs1C, 0x400 | (shamt & 0x1f)); // C.SRAI → srai
          if (sub === 2) return encI(rs1C, 7, rs1C, signExtend(shamt, 6)); // C.ANDI → andi
          // CA: C.SUB/XOR/OR/AND
          const f = (c >> 5) & 3;
          if ((c >> 12) & 1) break; // (reserved / word ops not in rv32)
          if (f === 0) return encR(rs1C, 0, rs1C, rdC, 0x20); // C.SUB
          if (f === 1) return encR(rs1C, 4, rs1C, rdC, 0); // C.XOR
          if (f === 2) return encR(rs1C, 6, rs1C, rdC, 0); // C.OR
          if (f === 3) return encR(rs1C, 7, rs1C, rdC, 0); // C.AND
          break;
        }
        case 5: // C.J → jal x0, off
          return this.encJ(0, c, pc);
        case 6: // C.BEQZ → beq rs1', x0, off
          return this.encB(c, 0, rs1C);
        case 7: // C.BNEZ → bne rs1', x0, off
          return this.encB(c, 1, rs1C);
      }
    } else if (op === 2) {
      switch (f3) {
        case 0: {
          // C.SLLI → slli rd, rd, shamt
          const shamt = (((c >> 12) & 1) << 5) | rs2Full;
          return encI(rdFull, 1, rdFull, shamt & 0x1f);
        }
        case 2: {
          // C.LWSP → lw rd, off(x2)
          const imm = (((c >> 2) & 3) << 6) | (((c >> 12) & 1) << 5) | (((c >> 4) & 7) << 2);
          return (((imm & 0xfff) << 20) | (2 << 15) | (2 << 12) | (rdFull << 7) | 0x03) >>> 0;
        }
        case 4: {
          const bit12 = (c >> 12) & 1;
          if (bit12 === 0) {
            if (rs2Full === 0) return (rdFull << 15) | (0 << 12) | (0 << 7) | 0x67; // C.JR → jalr x0, 0(rs1)
            return encR(rdFull, 0, 0, rs2Full, 0); // C.MV → add rd, x0, rs2
          }
          if (rs2Full === 0) {
            if (rdFull === 0) return 0x00100073; // C.EBREAK
            return (rdFull << 15) | (0 << 12) | (1 << 7) | 0x67; // C.JALR → jalr x1, 0(rs1)
          }
          return encR(rdFull, 0, rdFull, rs2Full, 0); // C.ADD → add rd, rd, rs2
        }
        case 6: {
          // C.SWSP → sw rs2, off(x2)
          const imm = (((c >> 7) & 3) << 6) | (((c >> 9) & 0xf) << 2);
          const immHi = (imm >> 5) & 0x7f;
          const immLo = imm & 0x1f;
          return (
            ((immHi << 25) | (rs2Full << 20) | (2 << 15) | (2 << 12) | (immLo << 7) | 0x23) >>> 0
          );
        }
      }
    }
    throw new Rv32Trap(CAUSE_ILLEGAL, pc, c);
  }

  /** Expand a C.J / C.JAL immediate into a JAL instruction word. */
  private encJ(rd: number, c: number, _pc: number): number {
    const imm =
      (((c >> 12) & 1) << 11) |
      (((c >> 11) & 1) << 4) |
      (((c >> 9) & 3) << 8) |
      (((c >> 8) & 1) << 10) |
      (((c >> 7) & 1) << 6) |
      (((c >> 6) & 1) << 7) |
      (((c >> 3) & 7) << 1) |
      (((c >> 2) & 1) << 5);
    const off = signExtend(imm, 12);
    // re-encode into JAL's scrambled immediate layout
    const u = off >>> 0;
    const j =
      (((u >> 20) & 1) << 31) |
      (((u >> 1) & 0x3ff) << 21) |
      (((u >> 11) & 1) << 20) |
      (((u >> 12) & 0xff) << 12);
    return (j | (rd << 7) | 0x6f) >>> 0;
  }

  /** Expand a C.BEQZ / C.BNEZ into a branch instruction word. */
  private encB(c: number, f3: number, rs1: number): number {
    const imm =
      (((c >> 12) & 1) << 8) |
      (((c >> 10) & 3) << 3) |
      (((c >> 5) & 3) << 6) |
      (((c >> 3) & 3) << 1) |
      (((c >> 2) & 1) << 5);
    const off = signExtend(imm, 9);
    const u = off >>> 0;
    const b =
      (((u >> 12) & 1) << 31) |
      (((u >> 5) & 0x3f) << 25) |
      (((u >> 1) & 0xf) << 8) |
      (((u >> 11) & 1) << 7);
    return (b | (rs1 << 15) | (f3 << 12) | 0x63) >>> 0;
  }
}

/** High 32 bits of a 32×32 product, with signed/unsigned operands (for MULH/MULHSU/MULHU). */
function mulh(a: number, b: number, aSigned: boolean, bSigned: boolean): number {
  const x = aSigned ? BigInt(a) : BigInt(a >>> 0);
  const y = bSigned ? BigInt(b) : BigInt(b >>> 0);
  return Number((x * y) >> 32n) | 0;
}
