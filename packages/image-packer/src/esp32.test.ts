import { describe, it, expect } from 'vitest';
import {
  espAppImage,
  elfToSegments,
  composePartitionTable,
  mergeFlash,
  packEsp32,
  DEFAULT_PARTITIONS,
  C3_OFFSETS,
  CHIP_ID,
  type EspSegment,
} from './esp32.js';

/** Build a minimal ELF32 (LE) with one PT_LOAD program header carrying `data` at vaddr. */
function makeElf(entry: number, paddr: number, data: Uint8Array): Uint8Array {
  const ehSize = 52;
  const phSize = 32;
  const phoff = ehSize;
  const dataOff = phoff + phSize;
  const elf = new Uint8Array(dataOff + data.length);
  const v = new DataView(elf.buffer);
  elf.set([0x7f, 0x45, 0x4c, 0x46], 0); // \x7fELF
  v.setUint32(24, entry, true); // e_entry
  v.setUint32(28, phoff, true); // e_phoff
  v.setUint16(42, phSize, true); // e_phentsize
  v.setUint16(44, 1, true); // e_phnum
  v.setUint32(phoff + 0, 1, true); // p_type = PT_LOAD
  v.setUint32(phoff + 4, dataOff, true); // p_offset
  v.setUint32(phoff + 12, paddr, true); // p_paddr
  v.setUint32(phoff + 16, data.length, true); // p_filesz
  elf.set(data, dataOff);
  return elf;
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('ESP32 app image', () => {
  it('writes the ESP magic, segment count, entry, and a 16-byte-aligned XOR checksum', async () => {
    const segs: EspSegment[] = [{ addr: 0x40080000, data: Uint8Array.of(1, 2, 3, 4) }];
    const img = await espAppImage(0x40080400, segs, { chip: 'esp32-c3', hashAppended: false });
    expect(img[0]).toBe(0xe9); // magic
    expect(img[1]).toBe(1); // segment count
    expect(new DataView(img.buffer).getUint32(4, true)).toBe(0x40080400); // entry
    expect(new DataView(img.buffer).getUint16(8 + 4, true)).toBe(CHIP_ID['esp32-c3']); // chip id
    // The checksum byte (last byte) = 0xEF ^ all segment data.
    expect(img[img.length - 1]).toBe(0xef ^ 1 ^ 2 ^ 3 ^ 4);
    expect(img.length % 16).toBe(0); // padded to a 16-byte boundary (incl. checksum)
  });

  it('appends a SHA-256 of the image when hashAppended (default)', async () => {
    const img = await espAppImage(0, [{ addr: 0, data: Uint8Array.of(0xaa) }], {});
    const body = img.slice(0, img.length - 32);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
    expect(hex(img.slice(img.length - 32))).toBe(hex(hash));
  });
});

describe('elf2image', () => {
  it('extracts PT_LOAD segments + entry from an ELF', () => {
    const data = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    const { entry, segments } = elfToSegments(makeElf(0x42000000, 0x3fc80000, data));
    expect(entry).toBe(0x42000000);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.addr).toBe(0x3fc80000);
    expect(Array.from(segments[0]!.data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('rejects a non-ELF buffer', () => {
    expect(() => elfToSegments(new Uint8Array(64))).toThrow(/not an ELF/);
  });
});

describe('partition table', () => {
  it('emits 0xAA50 entries + a 0xEBEB MD5 record', () => {
    const tbl = composePartitionTable();
    expect(tbl.length).toBe((DEFAULT_PARTITIONS.length + 1) * 32);
    // Each partition record starts with the 0xAA 0x50 magic.
    for (let i = 0; i < DEFAULT_PARTITIONS.length; i++) {
      expect([tbl[i * 32], tbl[i * 32 + 1]]).toEqual([0xaa, 0x50]);
    }
    const md5Rec = tbl.slice(DEFAULT_PARTITIONS.length * 32);
    expect([md5Rec[0], md5Rec[1]]).toEqual([0xeb, 0xeb]); // MD5 record magic
  });

  it('encodes the factory app partition offset/size/label', () => {
    const tbl = composePartitionTable();
    const factoryIdx = DEFAULT_PARTITIONS.findIndex((p) => p.label === 'factory');
    const rec = tbl.slice(factoryIdx * 32, factoryIdx * 32 + 32);
    const v = new DataView(rec.buffer, rec.byteOffset);
    expect(v.getUint32(4, true)).toBe(0x10000); // offset
    expect(v.getUint32(8, true)).toBe(0x100000); // size
    expect(new TextDecoder().decode(rec.slice(12, 19))).toBe('factory');
  });
});

describe('MD5 (used by the partition record)', () => {
  it('matches a reference MD5 implementation (node:crypto) over the table body', async () => {
    const { createHash } = await import('node:crypto');
    const tbl = composePartitionTable();
    const body = tbl.slice(0, tbl.length - 32); // entries; the MD5 covers exactly this
    const embedded = hex(tbl.slice(tbl.length - 16));
    const reference = createHash('md5').update(Buffer.from(body)).digest('hex');
    expect(embedded).toBe(reference); // our hand-written MD5 == esptool-compatible MD5
  });
});

describe('merge_bin', () => {
  it('places bootloader/partitions/app at the C3 offsets with 0xFF gaps', () => {
    const merged = mergeFlash(
      {
        bootloader: Uint8Array.of(0xe9, 0x03),
        partitions: Uint8Array.of(0xaa, 0x50),
        app: Uint8Array.of(0xe9, 0x01),
      },
      C3_OFFSETS,
    );
    expect(Array.from(merged.slice(0x0, 0x2))).toEqual([0xe9, 0x03]); // C3 bootloader at 0x0
    expect(Array.from(merged.slice(0x8000, 0x8002))).toEqual([0xaa, 0x50]);
    expect(Array.from(merged.slice(0x10000, 0x10002))).toEqual([0xe9, 0x01]);
    expect(merged[0x500]).toBe(0xff); // gap padding
    expect(merged[0x4000]).toBe(0xff);
  });
});

describe('packEsp32 (full pipeline)', () => {
  it('produces content-addressed app/partition/merged keys', async () => {
    const elf = makeElf(0x42000000, 0x3fc80000, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    const bootloader = Uint8Array.of(0xe9, 0x01, 0x02, 0x03);
    const img = await packEsp32(elf, bootloader);
    expect(img.appKey).toMatch(/^sha256:/);
    expect(img.partitionsKey).toMatch(/^sha256:/);
    expect(img.mergedFlashKey).toMatch(/^sha256:/);
    expect(img.merged.length).toBeGreaterThan(0x10000);
    expect(img.merged[0]).toBe(0xe9); // C3 bootloader sits at flash offset 0x0
    expect(img.merged[0x500]).toBe(0xff); // gap between bootloader and partition table
    // Reproducible: identical inputs → identical keys.
    const again = await packEsp32(elf, bootloader);
    expect(again.mergedFlashKey).toBe(img.mergedFlashKey);
  });
});
