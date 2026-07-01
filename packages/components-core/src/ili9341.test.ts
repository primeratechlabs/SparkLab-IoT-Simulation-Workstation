import { describe, it, expect } from 'vitest';
import { Ili9341 } from './ili9341.js';
import { MockCircuitHost } from './mock-host.js';

const CS = 10;
const DC = 9;

function setup(): { dev: Ili9341; host: MockCircuitHost } {
  const dev = new Ili9341('tft', CS, DC);
  const host = new MockCircuitHost();
  dev.attach(host);
  host.mcuWrite(CS, 'low'); // select the display
  return { dev, host };
}
const command = (h: MockCircuitHost, b: number): void => {
  h.mcuWrite(DC, 'low');
  h.spiTransfer(b);
};
const data = (h: MockCircuitHost, ...bs: number[]): void => {
  h.mcuWrite(DC, 'high');
  for (const b of bs) h.spiTransfer(b);
};
const be16 = (v: number): [number, number] => [(v >> 8) & 0xff, v & 0xff];

describe('ILI9341 SPI TFT', () => {
  it('draws RGB565 pixels into the window set by CASET/PASET/RAMWR', () => {
    const { dev, host } = setup();
    command(host, 0x2a); // CASET x = 10..12
    data(host, ...be16(10), ...be16(12));
    command(host, 0x2b); // PASET y = 20..20
    data(host, ...be16(20), ...be16(20));
    command(host, 0x2c); // RAMWR three pixels
    data(host, ...be16(0xf800), ...be16(0x07e0), ...be16(0x001f)); // red, green, blue

    expect(dev.pixelAt(10, 20)).toBe(0xf800);
    expect(dev.pixelAt(11, 20)).toBe(0x07e0);
    expect(dev.pixelAt(12, 20)).toBe(0x001f);
    expect(dev.pixelAt(13, 20)).toBe(0x0000); // outside the window stays black
    expect(dev.litPixels).toBe(3);
  });

  it('ignores traffic while not selected (CS high)', () => {
    const { dev, host } = setup();
    host.mcuWrite(CS, 'high'); // deselect
    command(host, 0x2a);
    data(host, ...be16(0), ...be16(0));
    command(host, 0x2c);
    data(host, ...be16(0xffff));
    expect(dev.litPixels).toBe(0);
  });

  it('wraps the cursor down a row at the window’s right edge', () => {
    const { dev, host } = setup();
    command(host, 0x2a); // x = 0..1
    data(host, ...be16(0), ...be16(1));
    command(host, 0x2b); // y = 0..1
    data(host, ...be16(0), ...be16(1));
    command(host, 0x2c); // 4 pixels fill the 2×2 window row-major
    data(host, ...be16(0x1111), ...be16(0x2222), ...be16(0x3333), ...be16(0x4444));
    expect(dev.pixelAt(0, 0)).toBe(0x1111);
    expect(dev.pixelAt(1, 0)).toBe(0x2222);
    expect(dev.pixelAt(0, 1)).toBe(0x3333); // wrapped to the next row
    expect(dev.pixelAt(1, 1)).toBe(0x4444);
  });
});
