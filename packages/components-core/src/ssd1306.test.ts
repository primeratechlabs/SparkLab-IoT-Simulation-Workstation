import { describe, it, expect } from 'vitest';
import type { I2cDevice } from '@sparklab/sim-kernel';
import { Ssd1306 } from './ssd1306.js';
import { MockCircuitHost } from './mock-host.js';

function tx(dev: I2cDevice, bytes: number[]): void {
  dev.startWrite();
  for (const b of bytes) dev.write(b);
  dev.stop();
}

function setup(): { oled: Ssd1306; dev: I2cDevice } {
  const host = new MockCircuitHost();
  const oled = new Ssd1306('oled');
  oled.attach(host);
  return { oled, dev: host.i2c.get(0x3c)! };
}

describe('Ssd1306', () => {
  it('registers as an I2C device at 0x3C', () => {
    const host = new MockCircuitHost();
    new Ssd1306('oled').attach(host);
    expect(host.i2c.has(0x3c)).toBe(true);
  });

  it('writes a data byte as 8 vertical pixels in the addressed column', () => {
    const { oled, dev } = setup();
    tx(dev, [0x00, 0x20, 0x00, 0x21, 0, 127, 0x22, 0, 7]); // horizontal, full screen
    tx(dev, [0x40, 0xff]); // column 0, page 0 → 8 lit pixels stacked vertically
    expect(oled.isPixelOn(0, 0)).toBe(true);
    expect(oled.isPixelOn(0, 7)).toBe(true);
    expect(oled.isPixelOn(0, 8)).toBe(false); // next page
    expect(oled.isPixelOn(1, 0)).toBe(false); // pointer advanced past column 0
    expect(oled.litPixels()).toBe(8);
  });

  it('horizontal addressing fills the whole 128x64 framebuffer', () => {
    const { oled, dev } = setup();
    tx(dev, [0x00, 0x20, 0x00, 0x21, 0, 127, 0x22, 0, 7]);
    const all: number[] = [0x40];
    for (let i = 0; i < 1024; i++) all.push(0xff);
    tx(dev, all);
    expect(oled.litPixels()).toBe(128 * 64); // every pixel on
    expect(oled.isPixelOn(127, 63)).toBe(true);
  });

  it('page mode places data at the selected page + column', () => {
    const { oled, dev } = setup();
    tx(dev, [0x00, 0x20, 0x02]); // page addressing
    tx(dev, [0x00, 0xb3, 0x10 | 0x0, 0x00 | 0x5]); // page 3, column high=0 low=5 → col 5
    tx(dev, [0x40, 0x01]); // bit0 → row page*8 = 24
    expect(oled.isPixelOn(5, 24)).toBe(true);
    expect(oled.isPixelOn(5, 25)).toBe(false);
  });

  it('ignores cosmetic commands (contrast, display on) without corrupting the bitmap', () => {
    const { oled, dev } = setup();
    tx(dev, [0x00, 0x81, 0x7f, 0xaf]); // set contrast 0x7F, display ON
    expect(oled.litPixels()).toBe(0);
  });
});
