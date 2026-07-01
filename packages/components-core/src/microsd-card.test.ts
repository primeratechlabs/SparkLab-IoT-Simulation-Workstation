import { describe, it, expect } from 'vitest';
import { MicroSdCard, buildFat16Image } from './microsd-card.js';
import { MockCircuitHost } from './mock-host.js';

const CS = 4;

function setup(): { dev: MicroSdCard; host: MockCircuitHost } {
  const dev = new MicroSdCard('sd', CS);
  const host = new MockCircuitHost();
  dev.attach(host);
  host.mcuWrite(CS, 'low');
  return { dev, host };
}
const xfer = (h: MockCircuitHost, b: number): number => h.spiTransfer(b);
/** Send a 6-byte SD command and read `respLen` response bytes (R1 first). */
function cmd(h: MockCircuitHost, idx: number, arg = 0, respLen = 1): number[] {
  for (const b of [
    0x40 | idx,
    (arg >>> 24) & 0xff,
    (arg >>> 16) & 0xff,
    (arg >>> 8) & 0xff,
    arg & 0xff,
    0x95,
  ])
    xfer(h, b);
  let r1 = 0xff;
  for (let i = 0; i < 8 && r1 & 0x80; i++) r1 = xfer(h, 0xff); // clock until R1 (bit7 clear)
  const rest = Array.from({ length: respLen - 1 }, () => xfer(h, 0xff));
  return [r1, ...rest];
}
function readBlockOverSpi(h: MockCircuitHost, block: number): number[] {
  expect(cmd(h, 17, block * 512)[0]).toBe(0x00); // byte address (standard capacity)
  let token = 0xff;
  for (let i = 0; i < 16 && token !== 0xfe; i++) token = xfer(h, 0xff);
  expect(token).toBe(0xfe);
  const data = Array.from({ length: 512 }, () => xfer(h, 0xff));
  xfer(h, 0xff);
  xfer(h, 0xff); // CRC
  return data;
}

describe('microSD card (SD-over-SPI + FAT16)', () => {
  it('runs the init handshake CMD0 → CMD8 → ACMD41 → CMD58', () => {
    const { host } = setup();
    expect(cmd(host, 0)[0]).toBe(0x01); // idle
    expect(cmd(host, 8, 0x1aa, 5)[0]).toBe(0x01); // SDv2, R7
    expect(cmd(host, 55)[0]).toBe(0x01); // APP_CMD
    expect(cmd(host, 41, 0x40000000)[0]).toBe(0x00); // ACMD41 → ready
    expect(cmd(host, 58, 0, 5)[0]).toBe(0x00); // READ_OCR
  });

  it('reads block 0 (the FAT16 boot sector) with the 0x55AA signature', () => {
    const { host } = setup();
    cmd(host, 0);
    cmd(host, 55);
    cmd(host, 41, 0x40000000);
    const block0 = readBlockOverSpi(host, 0);
    expect(block0[510]).toBe(0x55);
    expect(block0[511]).toBe(0xaa);
    expect(String.fromCharCode(...block0.slice(54, 62))).toBe('FAT16   ');
  });

  it('writes a block over SPI and reads it back', () => {
    const { dev, host } = setup();
    cmd(host, 0);
    cmd(host, 55);
    cmd(host, 41, 0x40000000);
    // CMD24 write block 100 with a marker pattern
    expect(cmd(host, 24, 100 * 512)[0]).toBe(0x00);
    xfer(host, 0xfe); // data token
    for (let i = 0; i < 512; i++) xfer(host, i & 0xff);
    xfer(host, 0xff);
    xfer(host, 0xff); // CRC
    const resp = xfer(host, 0xff); // data response
    expect(resp & 0x1f).toBe(0x05); // data accepted
    expect(Array.from(dev.readBlock(100))).toEqual(Array.from({ length: 512 }, (_, i) => i & 0xff));
  });
});

describe('FAT16 image builder', () => {
  it('produces a valid boot sector + a root-directory entry for the file', () => {
    const img = buildFat16Image([{ name: 'hello.txt', content: 'hi' }]);
    expect(img[510]).toBe(0x55);
    expect(img[511]).toBe(0xaa);
    // root dir starts after reserved(1) + 2×32 FAT sectors = sector 65
    const root = 65 * 512;
    expect(String.fromCharCode(...img.slice(root, root + 11))).toBe('HELLO   TXT');
    expect(img[root + 11]).toBe(0x20); // archive attribute
    const startCluster = img[root + 26]! | (img[root + 27]! << 8);
    const fileSize = img[root + 28]! | (img[root + 29]! << 8);
    expect(startCluster).toBe(2);
    expect(fileSize).toBe(2);
    // file content lives at cluster 2 (data region)
    const dataStart = (65 + 32) * 512;
    expect(String.fromCharCode(img[dataStart]!, img[dataStart + 1]!)).toBe('hi');
  });
});
