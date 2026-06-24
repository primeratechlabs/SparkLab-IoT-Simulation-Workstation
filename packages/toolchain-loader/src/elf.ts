/**
 * Minimal but structurally-valid ELF32 writer/parser.
 *
 * The Stage 1 stub linker emits a real ELF (correct e_ident magic, class, a
 * section header table with .text + .shstrtab) so the acceptance gate's "valid
 * ELF" check passes against a genuine parser. Stage 2/4 replace the stub with a
 * real wasm-ld/avr-ld ELF; this format stays compatible (same parser).
 *
 * Deterministic: output is a pure function of (payload, machine, type) with no
 * timestamps or build ids → reproducible (invariant I4).
 */

export const EM_AVR = 0x53; // 83
export const EM_RISCV = 0xf3; // 243
export const EM_XTENSA = 0x5e; // 94

export const ET_REL = 1;
export const ET_EXEC = 2;

const ELF32_EHSIZE = 52;
const ELF32_SHENTSIZE = 40;
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

function align4(n: number): number {
  return (n + 3) & ~3;
}

export interface ElfOptions {
  machine: number;
  type?: number;
  entry?: number;
}

/** Write a valid ELF32 (little-endian) wrapping `payload` as a .text section. */
export function writeElf32(payload: Uint8Array, opts: ElfOptions): Uint8Array {
  const type = opts.type ?? ET_EXEC;
  const machine = opts.machine;
  const entry = opts.entry ?? 0;

  // ".text\0.shstrtab\0" preceded by the leading NUL byte for index 0.
  const shstrtab = new TextEncoder().encode('\0.text\0.shstrtab\0');
  const nameText = 1; // offset of ".text"
  const nameShstrtab = 7; // offset of ".shstrtab"

  const textOff = ELF32_EHSIZE;
  const textSize = payload.length;
  const shstrOff = textOff + textSize;
  const shstrSize = shstrtab.length;
  const shoff = align4(shstrOff + shstrSize);
  const shnum = 3;
  const shstrndx = 2;
  const total = shoff + shnum * ELF32_SHENTSIZE;

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // e_ident
  buf.set([0x7f, 0x45, 0x4c, 0x46], 0); // \x7fELF
  buf[4] = 1; // EI_CLASS = ELFCLASS32
  buf[5] = 1; // EI_DATA = ELFDATA2LSB (little-endian)
  buf[6] = 1; // EI_VERSION = EV_CURRENT
  // bytes 7..15 zero (OSABI=0, padding)

  view.setUint16(16, type, true); // e_type
  view.setUint16(18, machine, true); // e_machine
  view.setUint32(20, 1, true); // e_version
  view.setUint32(24, entry, true); // e_entry
  view.setUint32(28, 0, true); // e_phoff (none)
  view.setUint32(32, shoff, true); // e_shoff
  view.setUint32(36, 0, true); // e_flags
  view.setUint16(40, ELF32_EHSIZE, true); // e_ehsize
  view.setUint16(42, 0, true); // e_phentsize
  view.setUint16(44, 0, true); // e_phnum
  view.setUint16(46, ELF32_SHENTSIZE, true); // e_shentsize
  view.setUint16(48, shnum, true); // e_shnum
  view.setUint16(50, shstrndx, true); // e_shstrndx

  buf.set(payload, textOff);
  buf.set(shstrtab, shstrOff);

  // Section headers
  const writeSh = (
    idx: number,
    name: number,
    shType: number,
    flags: number,
    offset: number,
    size: number,
    addralign: number,
  ) => {
    const base = shoff + idx * ELF32_SHENTSIZE;
    view.setUint32(base + 0, name, true);
    view.setUint32(base + 4, shType, true);
    view.setUint32(base + 8, flags, true);
    view.setUint32(base + 12, 0, true); // sh_addr
    view.setUint32(base + 16, offset, true);
    view.setUint32(base + 20, size, true);
    view.setUint32(base + 24, 0, true); // sh_link
    view.setUint32(base + 28, 0, true); // sh_info
    view.setUint32(base + 32, addralign, true);
    view.setUint32(base + 36, 0, true); // sh_entsize
  };
  writeSh(0, 0, SHT_NULL, 0, 0, 0, 0);
  writeSh(1, nameText, SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR, textOff, textSize, 1);
  writeSh(2, nameShstrtab, SHT_STRTAB, 0, shstrOff, shstrSize, 1);

  return buf;
}

export interface Elf32Header {
  type: number;
  machine: number;
  version: number;
  entry: number;
  shoff: number;
  shnum: number;
  shstrndx: number;
}

export function parseElf32Header(bytes: Uint8Array): Elf32Header {
  if (!isValidElf(bytes)) throw new Error('not a valid ELF32');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: view.getUint16(16, true),
    machine: view.getUint16(18, true),
    version: view.getUint32(20, true),
    entry: view.getUint32(24, true),
    shoff: view.getUint32(32, true),
    shnum: view.getUint16(48, true),
    shstrndx: view.getUint16(50, true),
  };
}

export function isValidElf(bytes: Uint8Array): boolean {
  if (bytes.length < ELF32_EHSIZE) return false;
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    return false;
  }
  if (bytes[4] !== 1) return false; // ELFCLASS32
  if (bytes[5] !== 1) return false; // little-endian
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shoff = view.getUint32(32, true);
  const shnum = view.getUint16(48, true);
  const shentsize = view.getUint16(46, true);
  if (shnum === 0) return false;
  if (shoff + shnum * shentsize > bytes.length) return false;
  return true;
}
