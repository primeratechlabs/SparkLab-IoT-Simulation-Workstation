import { describe, it, expect } from 'vitest';
import { parseIntelHex } from '@sparklab/emulators';
import { intelHexEmit, packIntelHex, hexImageFromText, avrElfToBytes, avrElfToHex } from './avr.js';

const SHT_PROGBITS = 1;
const SHF_ALLOC = 0x2;

/**
 * Build a minimal ELF32 with a single section header, enough for avrElfToBytes
 * to walk. Field offsets match the parser: shoff@32, shentsize@46, shnum@48.
 */
function makeElf(sh: {
  shType: number;
  shFlags: number;
  shAddr: number;
  shOffset: number;
  shSize: number;
  data?: Uint8Array;
}): Uint8Array {
  const shentsize = 40;
  const shoff = 52;
  const dataOff = sh.data ? sh.shOffset : 0;
  const total = Math.max(shoff + shentsize, dataOff + (sh.data?.length ?? 0));
  const elf = new Uint8Array(total);
  elf[0] = 0x7f;
  elf[1] = 0x45; // 'E'
  elf[2] = 0x4c; // 'L'
  elf[3] = 0x46; // 'F'
  const view = new DataView(elf.buffer);
  view.setUint32(32, shoff, true); // e_shoff
  view.setUint16(46, shentsize, true); // e_shentsize
  view.setUint16(48, 1, true); // e_shnum
  const b = shoff;
  view.setUint32(b + 4, sh.shType, true);
  view.setUint32(b + 8, sh.shFlags, true);
  view.setUint32(b + 12, sh.shAddr, true);
  view.setUint32(b + 16, sh.shOffset, true);
  view.setUint32(b + 20, sh.shSize, true);
  if (sh.data) elf.set(sh.data, sh.shOffset);
  return elf;
}

describe('AVR Intel HEX emit', () => {
  it('emits records that the emulator parser reads back identically (interop)', () => {
    const bytes = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
    const hex = intelHexEmit(bytes);
    const { bytes: parsed, length } = parseIntelHex(hex);
    expect(length).toBe(40);
    expect(Array.from(parsed.subarray(0, 40))).toEqual(Array.from(bytes));
  });

  it('produces valid checksums (parser would throw otherwise)', () => {
    const hex = intelHexEmit(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(() => parseIntelHex(hex)).not.toThrow();
    expect(hex.trimEnd().endsWith(':00000001FF')).toBe(true); // EOF record
  });

  it('is deterministic and content-addressed (I4/I5)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const a = await packIntelHex(bytes);
    const b = await packIntelHex(bytes);
    expect(a.hex).toBe(b.hex);
    expect(a.hexKey).toBe(b.hexKey);
    expect(a.hexKey).toMatch(/^sha256:/);
  });

  it('wraps an authoritative objcopy HEX into a content-addressed image', async () => {
    // HEX from avr-objcopy is the source of truth; hexImageFromText assigns the key.
    const objcopyHex = intelHexEmit(new Uint8Array([0x0c, 0x94, 0x34, 0x00])).trimEnd(); // no trailing \n
    const img = await hexImageFromText(objcopyHex);
    expect(img.hex.endsWith('\n')).toBe(true); // normalized
    expect(img.byteLength).toBe(4); // sums data-record lengths
    expect(img.hexKey).toMatch(/^sha256:/);
    expect((await hexImageFromText(objcopyHex)).hexKey).toBe(img.hexKey); // stable
  });

  it('byteLength counts only data records (ignores EOF and address records)', async () => {
    // Linear-address record (type 04) + two data records (4 + 2 bytes) + EOF.
    const hex = [
      ':020000040000FA', // ext linear address — not a data record
      ':04000000DEADBEEF13', // 4 data bytes
      ':02000400CAFE30', // 2 data bytes
      ':00000001FF', // EOF — not a data record
    ].join('\n');
    const img = await hexImageFromText(hex);
    expect(img.byteLength).toBe(6); // 4 + 2, excludes type 04 and 01
  });

  it('hexImageFromText tolerates an invalid/truncated length field (counts 0, no NaN)', async () => {
    // Second line is truncated so its length nibble ("X") is non-hex → parseInt NaN.
    const hex = [
      ':04000000DEADBEEF13', // valid: 4 data bytes
      ':XX', // truncated/garbage — length parse yields NaN
      ':00000001FF',
    ].join('\n');
    const img = await hexImageFromText(hex);
    expect(Number.isNaN(img.byteLength)).toBe(false);
    expect(img.byteLength).toBe(4); // garbage contributes 0, not NaN
  });
});

describe('AVR ELF → bytes/hex', () => {
  it('copies an allocated PROGBITS section to its load address', () => {
    const data = new Uint8Array([0x0c, 0x94, 0x34, 0x00]);
    const elf = makeElf({
      shType: SHT_PROGBITS,
      shFlags: SHF_ALLOC,
      shAddr: 0x10,
      shOffset: 92,
      shSize: data.length,
      data,
    });
    const out = avrElfToBytes(elf);
    expect(Array.from(out.subarray(0x10, 0x14))).toEqual(Array.from(data));
  });

  it('rejects a section whose shAddr+shSize wraps near 0xffffffff (no over-read, no throw)', () => {
    // A malformed/hostile section claiming a huge address+size. In JS the sum is a
    // double (0xfffffff0 + 0x100 = 0x1000000f0), which exceeds flashSize and must be
    // skipped — never wrapped to a small value that would pass the bound and over-read.
    const elf = makeElf({
      shType: SHT_PROGBITS,
      shFlags: SHF_ALLOC,
      shAddr: 0xfffffff0,
      shOffset: 0,
      shSize: 0x100,
    });
    const out = avrElfToBytes(elf); // must not throw
    expect(out.length).toBe(0x8000);
    expect(out.every((b) => b === 0)).toBe(true); // nothing copied
  });

  it('avrElfToHex trims trailing zeros from the flat image', async () => {
    // 2 non-zero bytes at addr 0 within a 0x8000 flash; HEX must not encode the rest.
    const data = new Uint8Array([0xaa, 0xbb]);
    const elf = makeElf({
      shType: SHT_PROGBITS,
      shFlags: SHF_ALLOC,
      shAddr: 0,
      shOffset: 92,
      shSize: data.length,
      data,
    });
    const img = await avrElfToHex(elf);
    expect(img.byteLength).toBe(2); // trimmed, not 0x8000
    const dataLines = img.hex
      .split('\n')
      .filter((l) => l.startsWith(':') && l.slice(7, 9) === '00');
    expect(dataLines).toHaveLength(1); // single 2-byte data record
    // Round-trips through the emulator parser at the right address.
    const { bytes } = parseIntelHex(img.hex);
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0xaa, 0xbb]);
  });
});
