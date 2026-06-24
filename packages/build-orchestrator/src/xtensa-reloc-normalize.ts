/**
 * Xtensa R_XTENSA_32 addend normalization — a link-input fixup that makes our generic wasm `ld.lld`
 * produce correct GCC-compiled jump tables (switch statements) for the ESP32-classic (Xtensa) target.
 *
 * THE BUG IT WORKS AROUND
 * -----------------------
 * The Xtensa psABI stores the addend of an `R_XTENSA_32` data relocation in the SECTION CONTENTS (the
 * implicit/REL-style addend), leaving the RELA `r_addend` field = 0 — this is required so the linker's
 * Xtensa relaxation can see the addend. The real `xtensa-esp-elf-ld` computes `*where = Sym + data + addend`.
 * Our `ld.lld` (a generic build) instead does `*where = Sym + r_addend` and DROPS the in-data addend, so e.g.
 * picolibc's `vfprintf` switch jump table — 36 `R_XTENSA_32` entries into `.text.vfprintf` whose per-case
 * offsets live in `.rodata` (0xb4, 0x211, …) — links to the function base for EVERY entry. `jx` then jumps to
 * the function prologue instead of the case handler, so any `%`-conversion is silently skipped.
 *
 * THE FIX
 * -------
 * Before linking, fold the in-data addend into the RELA record: for every `R_XTENSA_32` relocation set
 * `r_addend += *target_data` and zero those 4 bytes. After this, BOTH a correct (additive) and our broken
 * (overwriting) lld compute the same right answer `Sym + folded_addend`. Only type-1 relocations with a
 * non-zero in-data word are touched, so literal-pool / .init_array / function-pointer relocs (addend 0) are
 * untouched. Reproducible: idempotent (a second pass finds the data already zeroed → no-op).
 *
 * Operates on ELF32-LE objects and `ar` archives in place (no size change — only addend fields and the
 * folded data words are rewritten), so it is safe to run on every link input (sketch.o, rt.o, libc.a, …).
 */

const R_XTENSA_32 = 1; // relocation type whose addend the Xtensa ABI keeps in the section data
const SHT_RELA = 4;
const SHT_NOBITS = 8; // .bss — no file data to fold from

/** Normalize one ELF32 little-endian relocatable object IN PLACE. Returns the (same) buffer. */
function normalizeElf(buf: Uint8Array): Uint8Array {
  // Must be a little-endian 32-bit ELF (EI_MAG + EI_CLASS=1 + EI_DATA=1).
  if (buf.length < 0x34 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46)
    return buf;
  if (buf[4] !== 1 || buf[5] !== 1) return buf; // ELFCLASS32 + ELFDATA2LSB only
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const e_shoff = dv.getUint32(0x20, true);
  const e_shentsize = dv.getUint16(0x2e, true);
  const e_shnum = dv.getUint16(0x30, true);
  if (e_shoff === 0 || e_shnum === 0 || e_shentsize < 40) return buf;

  // Cache section (offset,size,type) so a RELA section can find its target's file data.
  const sh = (i: number, off: number) => dv.getUint32(e_shoff + i * e_shentsize + off, true);
  for (let i = 0; i < e_shnum; i++) {
    if (sh(i, 4) !== SHT_RELA) continue; // sh_type
    const relOff = sh(i, 16); // sh_offset of the RELA table
    const relSize = sh(i, 20); // sh_size
    const target = sh(i, 28); // sh_info → the section these relocations modify
    if (target >= e_shnum) continue;
    if (sh(target, 4) === SHT_NOBITS) continue; // .bss has no in-file data
    const tgtOff = sh(target, 16); // target sh_offset
    const tgtSize = sh(target, 20);
    for (let r = 0; r + 12 <= relSize; r += 12) {
      const base = relOff + r;
      const rInfo = dv.getUint32(base + 4, true);
      if ((rInfo & 0xff) !== R_XTENSA_32) continue;
      const rOffset = dv.getUint32(base, true);
      if (rOffset + 4 > tgtSize) continue; // out of range — leave untouched
      const dataPos = tgtOff + rOffset;
      const inData = dv.getUint32(dataPos, true);
      if (inData === 0) continue; // addend already in the record (or genuinely zero) — nothing to fold
      const rAddend = dv.getUint32(base + 8, true);
      dv.setUint32(base + 8, (rAddend + inData) >>> 0, true); // r_addend += *data
      dv.setUint32(dataPos, 0, true); // zero the folded word so an additive linker can't double-count
    }
  }
  return buf;
}

/** ASCII decimal field in an `ar` header (space-padded). */
function arInt(buf: Uint8Array, off: number, len: number): number {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[off + i]!);
  return parseInt(s.trim(), 10) || 0;
}

/**
 * Normalize a link input — an `ar` archive ("!<arch>\n") or a bare ELF object — IN PLACE, folding every
 * R_XTENSA_32 in-data addend into its RELA record. Returns the same buffer (mutated).
 */
export function normalizeXtensaRelocs(bytes: Uint8Array): Uint8Array {
  const isArchive =
    bytes.length >= 8 &&
    bytes[0] === 0x21 &&
    bytes[1] === 0x3c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x72 && // "!<ar"
    bytes[4] === 0x63 &&
    bytes[5] === 0x68 &&
    bytes[6] === 0x3e &&
    bytes[7] === 0x0a; // "ch>\n"
  if (!isArchive) return normalizeElf(bytes);

  // Walk ar members. Header is 60 bytes; size at offset 48 (10 ascii); data padded to an even length.
  let p = 8;
  while (p + 60 <= bytes.length) {
    const size = arInt(bytes, p + 48, 10);
    const dataStart = p + 60;
    if (dataStart + size > bytes.length) break;
    const name0 = bytes[dataStart],
      name1 = bytes[dataStart + 1],
      name2 = bytes[dataStart + 2],
      name3 = bytes[dataStart + 3];
    // Skip the symbol table ("/"), the long-name table ("//") — only real ELF members carry relocations.
    if (name0 === 0x7f && name1 === 0x45 && name2 === 0x4c && name3 === 0x46) {
      normalizeElf(bytes.subarray(dataStart, dataStart + size));
    }
    p = dataStart + size + (size & 1); // 2-byte alignment padding
  }
  return bytes;
}
