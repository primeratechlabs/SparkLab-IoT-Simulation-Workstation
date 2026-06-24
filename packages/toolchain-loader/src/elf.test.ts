import { describe, it, expect } from 'vitest';
import { writeElf32, parseElf32Header, isValidElf, EM_AVR, ET_EXEC } from './elf.js';

describe('elf32', () => {
  const payload = new TextEncoder().encode('some object code bytes');

  it('writes a valid ELF32 that parses', () => {
    const elf = writeElf32(payload, { machine: EM_AVR });
    expect(isValidElf(elf)).toBe(true);
    const h = parseElf32Header(elf);
    expect(h.machine).toBe(EM_AVR);
    expect(h.type).toBe(ET_EXEC);
    expect(h.shnum).toBe(3);
    expect(h.shstrndx).toBe(2);
  });

  it('starts with the ELF magic', () => {
    const elf = writeElf32(payload, { machine: EM_AVR });
    expect(Array.from(elf.slice(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46]);
  });

  it('is deterministic for identical input (I4)', () => {
    const a = writeElf32(payload, { machine: EM_AVR });
    const b = writeElf32(payload, { machine: EM_AVR });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('rejects corrupt magic', () => {
    const elf = writeElf32(payload, { machine: EM_AVR });
    elf[1] = 0;
    expect(isValidElf(elf)).toBe(false);
  });
});
