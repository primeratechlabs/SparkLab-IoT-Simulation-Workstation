import { describe, it, expect } from 'vitest';
import { elfLoad, elfMachine, ElfError, EM_RISCV, EM_XTENSA } from './elf-load.js';

/** Build a minimal valid ELF32 (one PT_LOAD) for a given machine, so we can then corrupt fields. */
function makeElf(machine: number, code = [0, 0, 0, 0]): Uint8Array {
  const EH = 52,
    PH = 32,
    codeOff = EH + PH;
  const buf = new Uint8Array(codeOff + code.length);
  const v = new DataView(buf.buffer);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0);
  v.setUint16(16, 2, true); // ET_EXEC
  v.setUint16(18, machine, true);
  v.setUint32(20, 1, true);
  v.setUint32(24, 0, true); // entry
  v.setUint32(28, EH, true); // phoff
  v.setUint16(40, EH, true);
  v.setUint16(42, PH, true);
  v.setUint16(44, 1, true); // phnum
  v.setUint32(EH + 0, 1, true); // PT_LOAD
  v.setUint32(EH + 4, codeOff, true);
  v.setUint32(EH + 16, code.length, true); // filesz
  buf.set(code, codeOff);
  return buf;
}

describe('elf-load — header validation fails closed (AUD-007)', () => {
  it('loads a valid RISC-V / Xtensa ELF and reports its machine', () => {
    expect(elfLoad(makeElf(EM_RISCV)).machine).toBe(EM_RISCV);
    expect(elfLoad(makeElf(EM_XTENSA)).machine).toBe(EM_XTENSA);
    expect(elfMachine(makeElf(EM_XTENSA))).toBe(EM_XTENSA);
  });

  it('rejects bad magic, wrong class/endianness, and unsupported machines', () => {
    const bad = makeElf(EM_RISCV);
    bad[1] = 0; // corrupt the 'E' of the magic
    expect(() => elfLoad(bad)).toThrow(ElfError);

    const wrongClass = makeElf(EM_RISCV);
    wrongClass[4] = 2; // ELFCLASS64
    expect(() => elfLoad(wrongClass)).toThrow(/32-bit/);

    expect(() => elfLoad(makeElf(40))).toThrow(/không được hỗ trợ/); // EM_ARM — not supported
    expect(() => elfLoad(new Uint8Array(8))).toThrow(/ngắn hơn/); // too short for a header
  });

  it('enforces an expected machine (no wrong-interpreter load)', () => {
    expect(() => elfLoad(makeElf(EM_XTENSA), EM_RISCV)).toThrow(/không khớp board/);
    expect(elfLoad(makeElf(EM_RISCV), EM_RISCV).machine).toBe(EM_RISCV);
  });

  it('rejects a segment that points outside the file (no DataView RangeError escapes)', () => {
    const e = makeElf(EM_RISCV);
    const v = new DataView(e.buffer);
    v.setUint32(52 + 16, 0xffffff, true); // filesz way beyond the file
    expect(() => elfLoad(e)).toThrow(/vượt ngoài file/);
  });
});
