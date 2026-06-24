/**
 * Unit coverage for the Xtensa R_XTENSA_32 addend-fold (xtensa-reloc-normalize.ts). Builds a minimal but
 * valid ELF32-LE relocatable object with a `.rodata` jump-table word whose addend lives in the section data
 * (RELA r_addend = 0 — the Xtensa convention) and asserts the normalizer moves the addend into the RELA
 * record and zeroes the data, so our generic ld.lld (`*where = Sym + r_addend`) links it correctly. Pure —
 * no toolchain needed.
 */
import { describe, it, expect } from 'vitest';
import { normalizeXtensaRelocs } from './xtensa-reloc-normalize.js';

const R_XTENSA_32 = 1;
const R_XTENSA_SLOT0_OP = 20;

/**
 * Hand-build a tiny ELF32-LE object: header + 4 sections (null, .rodata [4 data bytes], .rela.rodata [one
 * Elf32_Rela], .shstrtab). Returns the buffer + the byte offsets of the data word and the rela r_addend so
 * the test can read them back. `relType` lets us also assert a non-target reloc is left alone.
 */
function buildObject(
  dataWord: number,
  relAddend: number,
  relType: number,
): { buf: Uint8Array; dataPos: number; addendPos: number } {
  const EH = 52; // ELF32 header size
  const SH = 40; // section header size
  const shoff = EH;
  const nSec = 4;
  const dataPos = shoff + nSec * SH; // .rodata data right after the section headers
  const relPos = dataPos + 4; // .rela.rodata (one 12-byte Elf32_Rela)
  const total = relPos + 12;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  // ELF header.
  buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0); // magic + ELFCLASS32 + ELFDATA2LSB + version
  dv.setUint16(16, 1, true); // e_type = ET_REL
  dv.setUint16(18, 94, true); // e_machine = EM_XTENSA
  dv.setUint32(20, 1, true); // e_version
  dv.setUint32(0x20, shoff, true); // e_shoff
  dv.setUint16(0x2e, SH, true); // e_shentsize
  dv.setUint16(0x30, nSec, true); // e_shnum
  dv.setUint16(0x32, 3, true); // e_shstrndx

  const sh = (
    idx: number,
    fields: Partial<{ type: number; offset: number; size: number; info: number; entsize: number }>,
  ) => {
    const o = shoff + idx * SH;
    if (fields.type !== undefined) dv.setUint32(o + 4, fields.type, true);
    if (fields.offset !== undefined) dv.setUint32(o + 16, fields.offset, true);
    if (fields.size !== undefined) dv.setUint32(o + 20, fields.size, true);
    if (fields.info !== undefined) dv.setUint32(o + 28, fields.info, true);
    if (fields.entsize !== undefined) dv.setUint32(o + 36, fields.entsize, true);
  };
  // [0] null, [1] .rodata (target), [2] .rela.rodata (sh_info → 1), [3] .shstrtab (empty, satisfies shstrndx)
  sh(1, { type: 1 /*PROGBITS*/, offset: dataPos, size: 4 });
  sh(2, { type: 4 /*RELA*/, offset: relPos, size: 12, info: 1, entsize: 12 });
  sh(3, { type: 3 /*STRTAB*/, offset: total, size: 0 });

  // .rodata word (the in-data addend) + the single Elf32_Rela {r_offset=0, r_info=(1<<8)|type, r_addend}.
  dv.setUint32(dataPos, dataWord >>> 0, true);
  dv.setUint32(relPos, 0, true); // r_offset = 0 (start of .rodata)
  dv.setUint32(relPos + 4, (1 << 8) | relType, true); // r_info: sym 1, type
  dv.setUint32(relPos + 8, relAddend >>> 0, true); // r_addend

  return { buf, dataPos, addendPos: relPos + 8 };
}

describe('normalizeXtensaRelocs — fold R_XTENSA_32 in-data addend into the RELA record', () => {
  it('moves a non-zero data word into r_addend and zeroes the data', () => {
    const { buf, dataPos, addendPos } = buildObject(0xb4, 0, R_XTENSA_32);
    normalizeXtensaRelocs(buf);
    const dv = new DataView(buf.buffer);
    expect(dv.getUint32(addendPos, true)).toBe(0xb4); // folded
    expect(dv.getUint32(dataPos, true)).toBe(0); // data zeroed
  });

  it('adds the data word to a pre-existing r_addend (no data loss either way)', () => {
    const { buf, addendPos } = buildObject(0x10, 0x200, R_XTENSA_32);
    normalizeXtensaRelocs(buf);
    expect(new DataView(buf.buffer).getUint32(addendPos, true)).toBe(0x210);
  });

  it('is idempotent — a second pass is a no-op (data already zero)', () => {
    const { buf, dataPos, addendPos } = buildObject(0xb4, 0, R_XTENSA_32);
    normalizeXtensaRelocs(buf);
    normalizeXtensaRelocs(buf);
    expect(new DataView(buf.buffer).getUint32(addendPos, true)).toBe(0xb4); // not doubled
    expect(new DataView(buf.buffer).getUint32(dataPos, true)).toBe(0);
  });

  it('leaves non-R_XTENSA_32 relocations (e.g. SLOT0_OP code operands) untouched', () => {
    const { buf, dataPos, addendPos } = buildObject(0xb4, 0, R_XTENSA_SLOT0_OP);
    normalizeXtensaRelocs(buf);
    const dv = new DataView(buf.buffer);
    expect(dv.getUint32(addendPos, true)).toBe(0); // addend unchanged
    expect(dv.getUint32(dataPos, true)).toBe(0xb4); // data unchanged
  });

  it('returns non-ELF / non-archive input unchanged', () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    expect(normalizeXtensaRelocs(junk)).toBe(junk);
  });
});
