/**
 * Intel HEX parser — loads firmware HEX into a flash byte buffer for avr8js.
 * Supports record types 00 (data), 01 (EOF), 02/04 (segment/linear address).
 * Validates the per-record checksum (invariant I5: reject corrupt firmware).
 */

export interface ParsedHex {
  /** Flash bytes written (little-endian, as the AVR program memory expects). */
  bytes: Uint8Array;
  /** Highest byte address + 1 that received data. */
  length: number;
}

function hexByte(line: string, offset: number): number {
  // Guard against non-hex / truncated input: parseInt → NaN would otherwise be
  // silently masked to 0 by `& 0xff`, letting corrupt records pass the checksum.
  if (offset + 2 > line.length) throw new Error(`Intel HEX record truncated: ${line}`);
  const v = parseInt(line.substr(offset, 2), 16);
  if (Number.isNaN(v)) throw new Error(`Intel HEX invalid hex byte at offset ${offset}: ${line}`);
  return v;
}

export function parseIntelHex(hexText: string, flashSize = 0x8000): ParsedHex {
  const bytes = new Uint8Array(flashSize);
  let maxAddr = 0;
  let baseAddress = 0;

  for (const raw of hexText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] !== ':') continue;

    const len = hexByte(line, 1);
    const addr = (hexByte(line, 3) << 8) | hexByte(line, 5);
    const recordType = hexByte(line, 7);

    // Verify checksum (two's complement of the sum of all bytes incl. checksum == 0).
    let sum = 0;
    for (let i = 1; i < line.length; i += 2) sum = (sum + hexByte(line, i)) & 0xff;
    if (sum !== 0) throw new Error(`Intel HEX checksum error at record: ${line}`);

    if (recordType === 0x00) {
      const full = baseAddress + addr;
      for (let i = 0; i < len; i++) {
        const b = hexByte(line, 9 + i * 2);
        const target = full + i;
        if (target >= flashSize) throw new Error(`HEX address out of flash range: ${target}`);
        bytes[target] = b;
        if (target + 1 > maxAddr) maxAddr = target + 1;
      }
    } else if (recordType === 0x02) {
      baseAddress = ((hexByte(line, 9) << 8) | hexByte(line, 11)) << 4;
    } else if (recordType === 0x04) {
      baseAddress = ((hexByte(line, 9) << 8) | hexByte(line, 11)) << 16;
    } else if (recordType === 0x01) {
      break; // EOF
    }
  }

  return { bytes, length: maxAddr };
}
