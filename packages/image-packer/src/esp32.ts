/**
 * ESP32 image packing — REFERENCE-SPEC Stage 4. Ports the pieces of `esptool` that
 * esptool-js lacks (elf2image, partition-table compose, merge_bin) to pure TS so the
 * whole flash image is produced 100% client-side. ESP32-C3 is RISC-V (chip id 5).
 *
 *   ELF → app image  (8-byte common header + 16-byte extended header + segments +
 *                     XOR checksum aligned to 16 bytes + optional SHA-256)
 *   partition CSV  → 32-byte entries (magic 0xAA50) + MD5 entry (magic 0xEBEB)
 *   merge_bin      → bootloader@0x1000, partitions@0x8000, app@0x10000, 0xFF gaps
 *
 * Binary layout matches esptool; final boot validation requires a real toolchain ELF
 * (Stage 4 gate) — here it is structurally unit-tested (round-trips through our parser).
 */

import type { Sha256 } from '@sparklab/shared';
import { sha256 } from '@sparklab/shared';

export const CHIP_ID = { esp32: 0, 'esp32-s2': 2, 'esp32-c3': 5, 'esp32-s3': 9 } as const;
export type EspChip = keyof typeof CHIP_ID;

export interface EspSegment {
  addr: number;
  data: Uint8Array;
}

export interface EspImageOptions {
  chip?: EspChip;
  flashMode?: number; // 0 QIO,1 QOUT,2 DIO,3 DOUT
  flashFreqId?: number; // 0xf=80MHz default for C3
  flashSizeId?: number; // 2 = 4MB
  hashAppended?: boolean; // append SHA-256 (default true)
}

async function sha256Raw(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── ESP application image ──────────────────────────────────────────────────
const ESP_MAGIC = 0xe9;
const CHECKSUM_SEED = 0xef;

function extendedHeader(chip: EspChip, hashAppended: boolean): Uint8Array {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  b[0] = 0xee; // wp_pin disabled
  v.setUint16(4, CHIP_ID[chip], true); // chip_id (offset 4–5)
  // offset 6 min_chip_rev, 7–8 min_chip_rev_full stay 0
  v.setUint16(9, 0xffff, true); // max_chip_rev_full = 0xFFFF (no upper limit) — matches esptool
  b[15] = hashAppended ? 1 : 0; // hash_appended
  return b;
}

/** Assemble an ESP application image from load segments + entry point. */
export async function espAppImage(
  entry: number,
  segments: EspSegment[],
  opts: EspImageOptions = {},
): Promise<Uint8Array> {
  const chip = opts.chip ?? 'esp32-c3';
  const hashAppended = opts.hashAppended !== false;

  const common = new Uint8Array(8);
  const cv = new DataView(common.buffer);
  common[0] = ESP_MAGIC;
  common[1] = segments.length;
  common[2] = opts.flashMode ?? 2; // DIO
  common[3] = (((opts.flashSizeId ?? 2) & 0x0f) << 4) | ((opts.flashFreqId ?? 0xf) & 0x0f);
  cv.setUint32(4, entry >>> 0, true);

  const chunks: Uint8Array[] = [common, extendedHeader(chip, hashAppended)];
  let checksum = CHECKSUM_SEED;
  for (const seg of segments) {
    const head = new Uint8Array(8);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, seg.addr >>> 0, true);
    hv.setUint32(4, seg.data.length, true);
    chunks.push(head, seg.data);
    for (const byte of seg.data) checksum ^= byte;
  }

  let body = concat(chunks);
  // Pad so the checksum byte lands as the last byte of a 16-byte block.
  const pad = (16 - ((body.length + 1) % 16)) % 16;
  body = concat([body, new Uint8Array(pad), Uint8Array.of(checksum & 0xff)]);

  return hashAppended ? concat([body, await sha256Raw(body)]) : body;
}

/** Parse an ESP32 RISC-V ELF32 (LE) into load segments + entry (a minimal elf2image). */
export function elfToSegments(elf: Uint8Array): { entry: number; segments: EspSegment[] } {
  if (elf.length < 52 || elf[0] !== 0x7f || elf[1] !== 0x45) throw new Error('not an ELF');
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const entry = v.getUint32(24, true);
  const phoff = v.getUint32(28, true);
  const phentsize = v.getUint16(42, true);
  const phnum = v.getUint16(44, true);
  const segments: EspSegment[] = [];
  for (let i = 0; i < phnum; i++) {
    const base = phoff + i * phentsize;
    if (base + 32 > elf.length) break;
    const pType = v.getUint32(base + 0, true);
    const pOffset = v.getUint32(base + 4, true);
    const pPaddr = v.getUint32(base + 12, true);
    const pFilesz = v.getUint32(base + 16, true);
    if (pType === 1 /* PT_LOAD */ && pFilesz > 0 && pOffset + pFilesz <= elf.length) {
      segments.push({ addr: pPaddr, data: elf.slice(pOffset, pOffset + pFilesz) });
    }
  }
  return { entry, segments };
}

export async function elfToAppImage(elf: Uint8Array, opts?: EspImageOptions): Promise<Uint8Array> {
  const { entry, segments } = elfToSegments(elf);
  return espAppImage(entry, segments, opts);
}

export interface ParsedEspImage {
  entry: number;
  segments: EspSegment[];
  flashMode: number;
  flashSizeId: number;
  flashFreqId: number;
  chipId: number;
  hashAppended: boolean;
  checksumOk: boolean;
}

/** Parse an ESP application image (inverse of espAppImage) — used to validate against
 *  real esptool output and to re-pack from a vendor image. */
export function parseEspAppImage(img: Uint8Array): ParsedEspImage {
  if (img[0] !== ESP_MAGIC) throw new Error('not an ESP image (bad magic)');
  const v = new DataView(img.buffer, img.byteOffset, img.byteLength);
  const segCount = img[1]!;
  const flashMode = img[2]!;
  const flashSizeId = (img[3]! >> 4) & 0x0f;
  const flashFreqId = img[3]! & 0x0f;
  const entry = v.getUint32(4, true);
  const chipId = v.getUint16(8 + 4, true);
  const hashAppended = img[8 + 15] === 1;

  let off = 24; // 8 common + 16 extended
  const segments: EspSegment[] = [];
  let checksum = CHECKSUM_SEED;
  for (let i = 0; i < segCount; i++) {
    const addr = v.getUint32(off, true);
    const len = v.getUint32(off + 4, true);
    const data = img.slice(off + 8, off + 8 + len);
    segments.push({ addr, data });
    for (const b of data) checksum ^= b;
    off += 8 + len;
  }
  // The checksum byte is the last byte of the 16-byte-aligned block after the segments.
  const checksumPos = off + ((16 - ((off + 1) % 16)) % 16);
  const checksumOk = (img[checksumPos] ?? -1) === (checksum & 0xff);
  return { entry, segments, flashMode, flashSizeId, flashFreqId, chipId, hashAppended, checksumOk };
}

// ── Partition table ─────────────────────────────────────────────────────────
export interface PartitionEntry {
  label: string;
  type: number; // 0 app, 1 data
  subtype: number;
  offset: number;
  size: number;
  flags?: number;
}

/** A sensible default single-app layout (nvs/phy_init/factory). */
export const DEFAULT_PARTITIONS: PartitionEntry[] = [
  { label: 'nvs', type: 1, subtype: 0x02, offset: 0x9000, size: 0x6000 },
  { label: 'phy_init', type: 1, subtype: 0x01, offset: 0xf000, size: 0x1000 },
  { label: 'factory', type: 0, subtype: 0x00, offset: 0x10000, size: 0x100000 },
];

function partitionRecord(p: PartitionEntry): Uint8Array {
  const b = new Uint8Array(32);
  const v = new DataView(b.buffer);
  v.setUint16(0, 0x50aa, true); // magic bytes AA 50
  b[2] = p.type;
  b[3] = p.subtype;
  v.setUint32(4, p.offset >>> 0, true);
  v.setUint32(8, p.size >>> 0, true);
  b.set(new TextEncoder().encode(p.label).slice(0, 16), 12);
  v.setUint32(28, p.flags ?? 0, true);
  return b;
}

/** Compose the binary partition table: entries + a 0xEBEB MD5 integrity record. */
export function composePartitionTable(entries: PartitionEntry[] = DEFAULT_PARTITIONS): Uint8Array {
  const records = entries.map(partitionRecord);
  const body = concat(records);
  const md5Record = new Uint8Array(32).fill(0xff);
  md5Record[0] = 0xeb;
  md5Record[1] = 0xeb;
  md5Record.set(md5(body), 16);
  return concat([body, md5Record]);
}

// ── merge_bin ────────────────────────────────────────────────────────────────
export interface FlashOffsets {
  bootloader: number;
  partitions: number;
  app: number;
}
// ESP32-C3 (and S3/C6) boot the second-stage bootloader from flash offset 0x0, unlike
// the ESP32-classic 0x1000 — confirmed against a real arduino-cli/esptool merged image.
export const C3_OFFSETS: FlashOffsets = { bootloader: 0x0, partitions: 0x8000, app: 0x10000 };

/** Lay bootloader / partition-table / app into a single 0xFF-padded flash image. */
export function mergeFlash(
  parts: { bootloader: Uint8Array; partitions: Uint8Array; app: Uint8Array },
  offsets: FlashOffsets = C3_OFFSETS,
): Uint8Array {
  const placed = [
    { offset: offsets.bootloader, data: parts.bootloader },
    { offset: offsets.partitions, data: parts.partitions },
    { offset: offsets.app, data: parts.app },
  ];
  const end = Math.max(...placed.map((p) => p.offset + p.data.length));
  const flash = new Uint8Array(end).fill(0xff);
  for (const p of placed) flash.set(p.data, p.offset);
  return flash;
}

export interface EspFlashImage {
  app: Uint8Array;
  partitions: Uint8Array;
  merged: Uint8Array;
  appKey: Sha256;
  partitionsKey: Sha256;
  mergedFlashKey: Sha256;
}

/** Full pipeline: ELF + bootloader + partition layout → content-addressed flash image. */
export async function packEsp32(
  elf: Uint8Array,
  bootloader: Uint8Array,
  partitionEntries: PartitionEntry[] = DEFAULT_PARTITIONS,
  opts?: EspImageOptions & { offsets?: FlashOffsets },
): Promise<EspFlashImage> {
  const app = await elfToAppImage(elf, opts);
  const partitions = composePartitionTable(partitionEntries);
  const merged = mergeFlash({ bootloader, partitions, app }, opts?.offsets ?? C3_OFFSETS);
  const [appKey, partitionsKey, mergedFlashKey] = await Promise.all([
    sha256(app),
    sha256(partitions),
    sha256(merged),
  ]);
  return { app, partitions, merged, appKey, partitionsKey, mergedFlashKey };
}

// ── compact MD5 (RFC 1321) — needed for the partition-table integrity record ──
function md5(input: Uint8Array): Uint8Array {
  function rl(x: number, c: number): number {
    return (x << c) | (x >>> (32 - c));
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const origLen = input.length;
  const bitLen = origLen * 8;
  const withOne = origLen + 1;
  const padded = new Uint8Array((Math.ceil((withOne + 8) / 64) * 64) | 0);
  padded.set(input);
  padded[origLen] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rl(F, s[i]!)) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0 >>> 0, true);
  ov.setUint32(4, b0 >>> 0, true);
  ov.setUint32(8, c0 >>> 0, true);
  ov.setUint32(12, d0 >>> 0, true);
  return out;
}
