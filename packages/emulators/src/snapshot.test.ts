import { describe, it, expect } from 'vitest';
import { Rv32Cpu, SimpleBus } from './rv32.js';
import { XtensaCpu } from './xtensa.js';
import { snapshotRv32, restoreRv32, snapshotXtensa, restoreXtensa } from './snapshot.js';

// tiny rv32 encoders (inline)
const I = (imm: number, rs1: number, f3: number, rd: number, op: number) =>
  (((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0;
const J = (imm: number, rd: number) =>
  ((((imm >> 20) & 1) << 31) |
    (((imm >> 1) & 0x3ff) << 21) |
    (((imm >> 11) & 1) << 20) |
    (((imm >> 12) & 0xff) << 12) |
    (rd << 7) |
    0x6f) >>>
  0;
const addi = (rd: number, rs1: number, imm: number) => I(imm, rs1, 0, rd, 0x13);
const jal = (rd: number, imm: number) => J(imm, rd);

function makeCpu(words: number[]) {
  const bus = new SimpleBus(new Uint8Array(0x1000));
  words.forEach((w, i) => bus.write32(i * 4, w));
  return { cpu: new Rv32Cpu(bus), bus };
}

describe('emulator snapshot/restore (Stage 7, gate #3)', () => {
  it('restore gives an identical, instant start — 0 instructions vs a full boot', () => {
    const prog = [addi(5, 5, 1), jal(0, -4)]; // x5++ forever
    const boot = makeCpu(prog);
    for (let i = 0; i < 200; i++) boot.cpu.step(); // the "boot" cost we want to skip
    const snap = snapshotRv32(boot.cpu, boot.bus);

    const fresh = makeCpu(prog);
    restoreRv32(fresh.cpu, fresh.bus, snap); // executes ZERO instructions
    expect(fresh.cpu.cycles).toBe(200); // reached the booted state without running 200 steps
    expect(fresh.cpu.getReg(5)).toBe(boot.cpu.getReg(5));
    expect(fresh.cpu.pc).toBe(boot.cpu.pc);
    expect(Array.from(fresh.bus.ram)).toEqual(Array.from(boot.bus.ram));

    // continuing from the restored state matches the still-running booted CPU (determinism)
    for (let i = 0; i < 50; i++) {
      fresh.cpu.step();
      boot.cpu.step();
    }
    expect(fresh.cpu.getReg(5)).toBe(boot.cpu.getReg(5));
  });

  it('restore reverts registers + RAM to the snapshot', () => {
    const { cpu, bus } = makeCpu([addi(5, 5, 1)]);
    cpu.setReg(6, 0xabc);
    bus.write32(0x100, 0xdeadbeef);
    const snap = snapshotRv32(cpu, bus);

    cpu.setReg(6, 0);
    bus.write32(0x100, 0);
    cpu.pc = 0x40;
    restoreRv32(cpu, bus, snap);

    expect(cpu.getReg(6)).toBe(0xabc);
    expect(bus.read32(0x100) >>> 0).toBe(0xdeadbeef);
    expect(cpu.pc).toBe(snap.pc);
  });

  it('Xtensa snapshot/restore round-trips regs/pc/sar/cycles/RAM', () => {
    const bus = new SimpleBus(new Uint8Array(0x1000));
    const cpu = new XtensaCpu(bus);
    cpu.setReg(3, 0x1234);
    cpu.pc = 0x40;
    cpu.sar = 7;
    cpu.cycles = 99;
    bus.write32(0x80, 0xcafe);
    const snap = snapshotXtensa(cpu, bus);

    cpu.setReg(3, 0);
    cpu.pc = 0;
    cpu.sar = 0;
    cpu.cycles = 0;
    bus.write32(0x80, 0);
    restoreXtensa(cpu, bus, snap);

    expect(cpu.getReg(3)).toBe(0x1234);
    expect(cpu.pc).toBe(0x40);
    expect(cpu.sar).toBe(7);
    expect(cpu.cycles).toBe(99);
    expect(bus.read32(0x80) >>> 0).toBe(0xcafe);
  });

  it('rejects a cross-arch restore', () => {
    const { cpu, bus } = makeCpu([addi(5, 5, 1)]);
    const xsnap = snapshotXtensa(new XtensaCpu(bus), bus);
    expect(() => restoreRv32(cpu, bus, xsnap)).toThrow(/arch/);
  });
});
