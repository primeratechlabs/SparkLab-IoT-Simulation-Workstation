/**
 * AVR image packing — REFERENCE-SPEC Stage 2. ELF → Intel HEX (the avr8js load
 * format). When the real avr-gcc-wasm pack lands, avr-objcopy.wasm is authoritative;
 * this provides a deterministic in-TS path and the Intel HEX emitter used everywhere.
 */

import type { Sha256 } from '@sparklab/shared';
import { sha256 } from '@sparklab/shared';

const HEX = '0123456789ABCDEF';

function byte(n: number): string {
  return HEX[(n >> 4) & 0xf]! + HEX[n & 0xf]!;
}

function record(type: number, addr: number, data: number[]): string {
  const len = data.length;
  const bytes = [len, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
  const checksum = (0x100 - sum) & 0xff;
  return ':' + [...bytes, checksum].map(byte).join('');
}

/**
 * Emit Intel HEX for a contiguous byte buffer starting at `baseAddr`. Trailing
 * all-zero bytes beyond `length` are omitted. Deterministic (invariant I4).
 */
export function intelHexEmit(
  bytes: Uint8Array,
  opts: { baseAddr?: number; length?: number; bytesPerRecord?: number } = {},
): string {
  const baseAddr = opts.baseAddr ?? 0;
  const length = opts.length ?? bytes.length;
  const per = opts.bytesPerRecord ?? 16;
  const lines: string[] = [];

  for (let offset = 0; offset < length; offset += per) {
    const chunk: number[] = [];
    for (let i = 0; i < per && offset + i < length; i++) chunk.push(bytes[offset + i]!);
    lines.push(record(0x00, (baseAddr + offset) & 0xffff, chunk));
  }
  lines.push(record(0x01, 0, [])); // EOF
  return lines.join('\n') + '\n';
}

export interface HexImage {
  hex: string;
  hexKey: Sha256;
  byteLength: number;
}

export async function packIntelHex(
  bytes: Uint8Array,
  opts?: { baseAddr?: number; length?: number },
): Promise<HexImage> {
  const hex = intelHexEmit(bytes, opts);
  return { hex, hexKey: await sha256(hex), byteLength: opts?.length ?? bytes.length };
}

// ── ELF32 → flat image (allocated PROGBITS) ────────────────────────────────
// Minimal ELF32 section walk; for real AVR ELFs from the toolchain. avr-objcopy
// remains authoritative once the toolchain pack exists (TODO Stage 2 final).

const SHT_PROGBITS = 1;
const SHF_ALLOC = 0x2;

export function avrElfToBytes(elf: Uint8Array, flashSize = 0x8000): Uint8Array {
  if (elf.length < 52 || elf[0] !== 0x7f || elf[1] !== 0x45) throw new Error('not an ELF');
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const shoff = view.getUint32(32, true);
  const shentsize = view.getUint16(46, true);
  const shnum = view.getUint16(48, true);
  const out = new Uint8Array(flashSize);

  for (let i = 0; i < shnum; i++) {
    const base = shoff + i * shentsize;
    if (base + 40 > elf.length) break;
    const shType = view.getUint32(base + 4, true);
    const shFlags = view.getUint32(base + 8, true);
    const shAddr = view.getUint32(base + 12, true);
    const shOffset = view.getUint32(base + 16, true);
    const shSize = view.getUint32(base + 20, true);
    if (
      shType === SHT_PROGBITS &&
      shFlags & SHF_ALLOC &&
      shAddr + shSize <= flashSize &&
      shOffset + shSize <= elf.length // source bound: don't over-read a malformed ELF
    ) {
      out.set(elf.subarray(shOffset, shOffset + shSize), shAddr);
    }
  }
  return out;
}

export async function avrElfToHex(elf: Uint8Array): Promise<HexImage> {
  const bytes = avrElfToBytes(elf);
  // Trim trailing zeros for a compact HEX.
  let len = bytes.length;
  while (len > 0 && bytes[len - 1] === 0) len--;
  return packIntelHex(bytes, { length: len });
}

/**
 * Wrap an authoritative Intel-HEX string (e.g. from avr-objcopy.wasm) into a
 * content-addressed image. objcopy is the source of truth for the flash layout
 * (handles .data LMA correctly); this just assigns the hexKey (invariant I5).
 */
export async function hexImageFromText(hex: string): Promise<HexImage> {
  const normalized = hex.endsWith('\n') ? hex : hex + '\n';
  const byteLength = normalized
    .split('\n')
    .filter((l) => l.startsWith(':') && l.slice(7, 9) === '00') // data records only
    .reduce((n, l) => {
      const len = parseInt(l.slice(1, 3), 16);
      return n + (Number.isNaN(len) ? 0 : len);
    }, 0);
  return { hex: normalized, hexKey: await sha256(normalized), byteLength };
}
