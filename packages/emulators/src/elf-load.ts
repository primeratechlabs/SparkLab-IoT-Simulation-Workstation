/**
 * Minimal ELF32 program loader — reads the entry point + PT_LOAD segments from a little-endian ELF (the
 * sim-build-profile firmware: `-Ttext=0` flat, no bootloader/partition). Shared by the C3/Xtensa runtimes
 * and the sim worker so the "load firmware into RAM" step lives in one place.
 *
 * Validates the header + segment bounds BEFORE trusting any offset (AUD-007): a corrupt or foreign ELF
 * fails closed with a structured error instead of producing a DataView RangeError or silently running as
 * the wrong architecture.
 */
export interface ElfImage {
  entry: number;
  machine: number;
  segments: { addr: number; data: Uint8Array }[];
}

export const EM_RISCV = 243;
export const EM_XTENSA = 94;
/** The e_machine values the simulator can actually execute. Anything else is rejected, never run. */
export const SUPPORTED_MACHINES: ReadonlySet<number> = new Set([EM_RISCV, EM_XTENSA]);

/** Raised when an ELF is malformed or targets an unsupported architecture. */
export class ElfError extends Error {}

/** e_machine (architecture) of an ELF, without fully loading it. */
export function elfMachine(elf: Uint8Array): number {
  return (elf[18] ?? 0) | ((elf[19] ?? 0) << 8);
}

/**
 * Parse + validate a 32-bit little-endian ELF. `expectMachine`, when given, must match the ELF's
 * e_machine (so a board's firmware can't be loaded into the wrong interpreter). Throws {@link ElfError}.
 */
export function elfLoad(elf: Uint8Array, expectMachine?: number): ElfImage {
  if (elf.length < 52) throw new ElfError('ELF không hợp lệ: header ngắn hơn 52 byte.');
  if (elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46)
    throw new ElfError('Không phải file ELF (magic không khớp).');
  if (elf[4] !== 1) throw new ElfError('ELF không phải 32-bit (EI_CLASS != ELFCLASS32).');
  if (elf[5] !== 1) throw new ElfError('ELF không phải little-endian (EI_DATA != ELFDATA2LSB).');
  const machine = elfMachine(elf);
  if (!SUPPORTED_MACHINES.has(machine))
    throw new ElfError(
      `Kiến trúc ELF không được hỗ trợ (e_machine=${machine}; chỉ RISC-V/Xtensa).`,
    );
  if (expectMachine !== undefined && machine !== expectMachine)
    throw new ElfError(`Kiến trúc ELF (${machine}) không khớp board đã chọn (${expectMachine}).`);

  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const entry = v.getUint32(24, true);
  const phoff = v.getUint32(28, true);
  const phes = v.getUint16(42, true);
  const phn = v.getUint16(44, true);
  if (phes < 32 || phoff + phn * phes > elf.length)
    throw new ElfError('ELF không hợp lệ: bảng program-header vượt ngoài file.');

  const segments: { addr: number; data: Uint8Array }[] = [];
  for (let i = 0; i < phn; i++) {
    const p = phoff + i * phes;
    if (v.getUint32(p, true) !== 1) continue; // PT_LOAD only
    const off = v.getUint32(p + 4, true);
    const vaddr = v.getUint32(p + 8, true);
    const filesz = v.getUint32(p + 16, true);
    if (off + filesz > elf.length) throw new ElfError('ELF không hợp lệ: segment vượt ngoài file.');
    if (filesz > 0) segments.push({ addr: vaddr, data: elf.slice(off, off + filesz) });
  }
  return { entry, machine, segments };
}
