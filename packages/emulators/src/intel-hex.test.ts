import { describe, it, expect } from 'vitest';
import { parseIntelHex } from './intel-hex.js';

describe('parseIntelHex', () => {
  it('parses data records and respects the checksum', () => {
    // :03000000010203F7  → 3 bytes 01 02 03 at addr 0, checksum F7
    const { bytes, length } = parseIntelHex(':03000000010203F7\n:00000001FF\n');
    expect(Array.from(bytes.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(length).toBe(3);
  });

  it('rejects a corrupt checksum (I5)', () => {
    expect(() => parseIntelHex(':03000000010203FF\n')).toThrow(/checksum/);
  });

  it('ignores blank lines and stops at EOF', () => {
    const { length } = parseIntelHex('\n:00000001FF\n:0100000002FD\n');
    expect(length).toBe(0); // EOF before the data record
  });

  it('rejects a truncated data record (declared length exceeds line)', () => {
    expect(() => parseIntelHex(':0300000001\n')).toThrow();
  });

  it('rejects non-hex characters', () => {
    expect(() => parseIntelHex(':03000000ZZZZZZxx\n')).toThrow();
  });

  it('honors extended linear address records (type 04) at base 0', () => {
    // :02000004 0000 FA  (set upper addr = 0), then 1 byte at 0
    const { bytes, length } = parseIntelHex(':020000040000FA\n:0100000042BD\n:00000001FF\n');
    expect(bytes[0]).toBe(0x42);
    expect(length).toBe(1);
  });

  it('tolerates CRLF line endings', () => {
    const { length } = parseIntelHex(':0100000042BD\r\n:00000001FF\r\n');
    expect(length).toBe(1);
  });

  it('returns empty for whitespace-only input', () => {
    expect(parseIntelHex('   \n\n').length).toBe(0);
  });
});
