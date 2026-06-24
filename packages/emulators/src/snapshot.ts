/**
 * Stage 7 — emulator snapshot/restore (perf, gate #3). Booting a firmware to the start of loop()
 * costs many instructions every run. Instead: boot once, snapshot the CPU + RAM, then restore
 * (an O(RAM) memcpy) for each run — instant start, and a deterministic base for replay. Restoring
 * executes ZERO instructions, so the saved start cost is exactly the boot prefix.
 */
import type { Rv32Cpu, SimpleBus } from './rv32.js';
import type { XtensaCpu } from './xtensa.js';

export interface CpuSnapshot {
  arch: 'rv32' | 'xtensa';
  regs: Int32Array;
  pc: number;
  cycles: number;
  sar?: number; // Xtensa shift-amount register
  csr?: Record<number, number>; // rv32 CSRs
  ram: Uint8Array;
}

export function snapshotRv32(cpu: Rv32Cpu, bus: SimpleBus): CpuSnapshot {
  return {
    arch: 'rv32',
    regs: cpu.regs.slice(),
    pc: cpu.pc,
    cycles: cpu.cycles,
    csr: { ...cpu.csr },
    ram: bus.ram.slice(),
  };
}

export function restoreRv32(cpu: Rv32Cpu, bus: SimpleBus, snap: CpuSnapshot): void {
  if (snap.arch !== 'rv32') throw new Error(`restoreRv32: snapshot arch is ${snap.arch}`);
  cpu.regs.set(snap.regs);
  cpu.pc = snap.pc;
  cpu.cycles = snap.cycles;
  cpu.csr = { ...(snap.csr ?? {}) };
  bus.ram.set(snap.ram);
}

export function snapshotXtensa(cpu: XtensaCpu, bus: SimpleBus): CpuSnapshot {
  return {
    arch: 'xtensa',
    regs: cpu.regs.slice(),
    pc: cpu.pc,
    cycles: cpu.cycles,
    sar: cpu.sar,
    ram: bus.ram.slice(),
  };
}

export function restoreXtensa(cpu: XtensaCpu, bus: SimpleBus, snap: CpuSnapshot): void {
  if (snap.arch !== 'xtensa') throw new Error(`restoreXtensa: snapshot arch is ${snap.arch}`);
  cpu.regs.set(snap.regs);
  cpu.pc = snap.pc;
  cpu.cycles = snap.cycles;
  cpu.sar = snap.sar ?? 0;
  bus.ram.set(snap.ram);
}
