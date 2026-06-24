import { describe, it, expect } from 'vitest';
import { Ws2812 } from './ws2812.js';
import { MockCircuitHost } from './mock-host.js';

/** Feed one WS2812 bit on `pin`: a HIGH pulse (~0.8µs=1, ~0.4µs=0) then a LOW. */
function bit(host: MockCircuitHost, pin: number, one: boolean): void {
  host.mcuWrite(pin, 'high');
  host.advance(one ? 800 : 400);
  host.mcuWrite(pin, 'low');
  host.advance(one ? 450 : 850);
}

/** Send a 24-bit GRB colour (G, R, B), MSB first. */
function sendColor(host: MockCircuitHost, pin: number, g: number, r: number, b: number): void {
  for (const byte of [g, r, b]) {
    for (let i = 7; i >= 0; i--) bit(host, pin, ((byte >> i) & 1) === 1);
  }
}

describe('Ws2812', () => {
  it('decodes one pixel (GRB order) from bit-banged pulse widths', () => {
    const host = new MockCircuitHost();
    const strip = new Ws2812('strip', 6);
    strip.attach(host);
    sendColor(host, 6, 0x00, 0xff, 0x00); // green LED = R=255 in GRB? no: GRB → G=0,R=255,B=0 is RED
    strip.flush();
    expect(strip.pixels).toEqual([{ g: 0x00, r: 0xff, b: 0x00 }]);
  });

  it('decodes multiple pixels and latches on a ≥50µs reset gap', () => {
    const host = new MockCircuitHost();
    const strip = new Ws2812('strip', 6);
    strip.attach(host);
    sendColor(host, 6, 10, 20, 30);
    sendColor(host, 6, 40, 50, 60);
    // A long LOW then a rising edge latches the frame.
    host.advance(60_000);
    host.mcuWrite(6, 'high');
    expect(strip.pixels).toEqual([
      { g: 10, r: 20, b: 30 },
      { g: 40, r: 50, b: 60 },
    ]);
  });

  it('distinguishes 0 and 1 bits by pulse width', () => {
    const host = new MockCircuitHost();
    const strip = new Ws2812('strip', 6);
    strip.attach(host);
    sendColor(host, 6, 0xaa, 0x55, 0xff); // mixed bit patterns
    strip.flush();
    expect(strip.pixels[0]).toEqual({ g: 0xaa, r: 0x55, b: 0xff });
  });
});
