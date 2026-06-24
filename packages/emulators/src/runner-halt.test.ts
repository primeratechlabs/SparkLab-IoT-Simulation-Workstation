import { describe, it, expect } from 'vitest';
import { Rv32Runner } from './rv32-runner.js';
import { XtensaRunner } from './xtensa-runner.js';

/** Build a minimal flat ELF (one PT_LOAD at `entry`) wrapping raw machine code — enough for a runner to
 *  load + execute. `machine` = EM_RISCV (243) or EM_XTENSA (94). Mirrors the `-Ttext=0` / flat sim-profile
 *  firmware shape (see elf-load.ts). */
function makeElf(code: Uint8Array, machine: number, entry = 0): Uint8Array {
  const EH = 52,
    PH = 32,
    codeOff = EH + PH;
  const buf = new Uint8Array(codeOff + code.length);
  const v = new DataView(buf.buffer);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0); // \x7fELF + ELFCLASS32 + ELFDATA2LSB + EV_CURRENT
  v.setUint16(16, 2, true); // e_type = ET_EXEC
  v.setUint16(18, machine, true); // e_machine
  v.setUint32(20, 1, true); // e_version
  v.setUint32(24, entry, true); // e_entry
  v.setUint32(28, EH, true); // e_phoff
  v.setUint16(40, EH, true); // e_ehsize
  v.setUint16(42, PH, true); // e_phentsize
  v.setUint16(44, 1, true); // e_phnum
  v.setUint32(EH + 0, 1, true); // p_type = PT_LOAD
  v.setUint32(EH + 4, codeOff, true); // p_offset
  v.setUint32(EH + 8, entry, true); // p_vaddr
  v.setUint32(EH + 12, entry, true); // p_paddr
  v.setUint32(EH + 16, code.length, true); // p_filesz
  v.setUint32(EH + 20, code.length, true); // p_memsz
  v.setUint32(EH + 24, 7, true); // p_flags = RWX
  v.setUint32(EH + 28, 4, true); // p_align
  buf.set(code, codeOff);
  return buf;
}
const makeRv32Elf = (code: Uint8Array, entry = 0): Uint8Array => makeElf(code, 243, entry);
const makeXtensaElf = (code: Uint8Array, entry = 0): Uint8Array => makeElf(code, 94, entry);

describe('runner halt — a firmware trap is SURFACED, never silently swallowed', () => {
  it('Rv32Runner halts + reports an illegal/unimplemented instruction (anti-silent-fake)', () => {
    // 0x0000 is the illegal-instruction encoding clang emits for __builtin_trap / an unsupported opcode.
    const runner = new Rv32Runner(makeRv32Elf(Uint8Array.from([0x00, 0x00])));
    expect(runner.halted).toBe(false);
    expect(runner.haltReason).toBeNull();

    runner.executeForMillis(5);

    expect(runner.halted).toBe(true); // the trap is observable — the run is known-dead
    expect(runner.haltReason).toMatch(/unimplemented or illegal/i); // a real, specific cause for the UI
  });

  it('once halted, further execution is a no-op (no spinning over dead firmware presented as a live run)', () => {
    const runner = new Rv32Runner(makeRv32Elf(Uint8Array.from([0x00, 0x00])));
    runner.executeForMillis(5);
    const frozen = runner.virtualTimeNs;
    runner.executeForMillis(100); // would advance time if it kept "running"
    expect(runner.virtualTimeNs).toBe(frozen); // time does NOT advance — the run is honestly stopped
  });

  // The Xtensa interpreter is a SUBSET decoder — the piece most likely to hit an opcode it doesn't
  // implement — so the anti-silent-fake guarantee matters MOST here. runner-halt previously only covered
  // Rv32 (xtensa-core audit P6 — coverage gap + louder traps).
  it('XtensaRunner halts + reports the unimplemented opcode (anti-silent-fake)', () => {
    // op0=0 (wide QRST), op1=7 — an op1 the decoder does not handle → XtensaTrap("QRST op1=7 …").
    const runner = new XtensaRunner(makeXtensaElf(Uint8Array.from([0x00, 0x00, 0x07])));
    expect(runner.halted).toBe(false);
    expect(runner.haltReason).toBeNull();

    for (let i = 0; i < 5 && !runner.halted; i++) runner.executeForMillis(5);

    expect(runner.halted).toBe(true); // the trap is observable — the run is known-dead, not faked
    expect(runner.haltReason).toMatch(/unimplemented CPU instruction/i);
    expect(runner.haltReason).toContain('QRST op1=7'); // names the exact opcode for the UI
  });

  it('XtensaRunner: a BREAK (abort/__builtin_trap) halts with an intentional-abort reason, not a decode gap', () => {
    const runner = new XtensaRunner(makeXtensaElf(Uint8Array.from([0x00, 0x40, 0x00]))); // r=4 in ST0 → BREAK
    for (let i = 0; i < 5 && !runner.halted; i++) runner.executeForMillis(5);
    expect(runner.halted).toBe(true);
    expect(runner.haltReason).toMatch(/aborted \(BREAK/i); // distinguished from an unimplemented opcode
  });
});
