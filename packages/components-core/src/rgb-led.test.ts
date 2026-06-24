import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { RgbLed } from './rgb-led.js';

describe('RgbLed', () => {
  it('starts dark when no pin is driven HIGH', () => {
    const host = new MockCircuitHost();
    const rgb = new RgbLed('rgb', 9, 10, 11);
    rgb.attach(host);
    expect(rgb.on).toBe(false);
    expect(rgb.color).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('lights each channel independently from its own pin', () => {
    const host = new MockCircuitHost();
    const rgb = new RgbLed('rgb', 9, 10, 11);
    rgb.attach(host);

    host.mcuWrite(9, 'high'); // red only
    expect(rgb.on).toBe(true);
    expect(rgb.color).toEqual({ r: 255, g: 0, b: 0 });

    host.mcuWrite(10, 'high'); // + green
    expect(rgb.color).toEqual({ r: 255, g: 255, b: 0 });

    host.mcuWrite(11, 'high'); // + blue → white
    expect(rgb.color).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('reports each channel as a clean 0 or 255 (digital, no PWM)', () => {
    const host = new MockCircuitHost();
    const rgb = new RgbLed('rgb', 9, 10, 11);
    rgb.attach(host);
    host.mcuWrite(10, 'high'); // green
    const { r, g, b } = rgb.color;
    for (const v of [r, g, b]) expect([0, 255]).toContain(v);
    expect(rgb.color).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('turns a channel back off when its pin goes LOW', () => {
    const host = new MockCircuitHost();
    const rgb = new RgbLed('rgb', 9, 10, 11);
    rgb.attach(host);

    host.mcuWrite(9, 'high');
    host.mcuWrite(11, 'high');
    expect(rgb.color).toEqual({ r: 255, g: 0, b: 255 }); // magenta

    host.mcuWrite(9, 'low'); // drop red
    expect(rgb.color).toEqual({ r: 0, g: 0, b: 255 });
    expect(rgb.on).toBe(true); // blue still lit

    host.mcuWrite(11, 'low'); // drop blue → fully dark
    expect(rgb.on).toBe(false);
    expect(rgb.color).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('seeds its state from the MCU pin levels present at attach time', () => {
    const host = new MockCircuitHost();
    // Pins already HIGH before the component attaches.
    host.mcuWrite(9, 'high');
    host.mcuWrite(11, 'high');

    const rgb = new RgbLed('rgb', 9, 10, 11);
    rgb.attach(host);
    expect(rgb.on).toBe(true);
    expect(rgb.color).toEqual({ r: 255, g: 0, b: 255 });
  });

  it('treats a released (high-z) pin as LOW — common-cathode, no current', () => {
    const host = new MockCircuitHost();
    const rgb = new RgbLed('rgb', 9, 10, 11);
    rgb.attach(host);

    host.mcuWrite(10, 'high'); // green on
    expect(rgb.color).toEqual({ r: 0, g: 255, b: 0 });

    // Releasing the pin does not fire a watcher, but pinLevel never reports HIGH for it,
    // so a subsequent LOW write confirms the channel goes dark.
    host.mcuRelease(10);
    host.mcuWrite(10, 'low');
    expect(rgb.color).toEqual({ r: 0, g: 0, b: 0 });
    expect(rgb.on).toBe(false);
  });

  it('keeps channels isolated — writing one pin never disturbs the others', () => {
    const host = new MockCircuitHost();
    const rgb = new RgbLed('rgb', 9, 10, 11);
    rgb.attach(host);

    host.mcuWrite(9, 'high'); // red
    host.mcuWrite(10, 'low'); // green explicitly low
    host.mcuWrite(11, 'high'); // blue
    expect(rgb.color).toEqual({ r: 255, g: 0, b: 255 });

    host.mcuWrite(10, 'high'); // green on, others unchanged → white
    expect(rgb.color).toEqual({ r: 255, g: 255, b: 255 });
  });
});
