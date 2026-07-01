import { describe, it, expect } from 'vitest';
import { Hx711 } from './hx711.js';
import { MockCircuitHost } from './mock-host.js';

const DT = 20;
const SCK = 21;

/** Clock out one 24-bit frame the way the bogde HX711 lib does; returns the value read MSB-first. */
function readFrame(h: Hx711, host: MockCircuitHost): number {
  let v = 0;
  for (let i = 0; i < 24; i++) {
    host.mcuWrite(SCK, 'high'); // rising edge → chip presents the next bit on DT
    v = (v << 1) | (host.driven.get(DT) === 'high' ? 1 : 0);
    host.mcuWrite(SCK, 'low');
  }
  return v >>> 0;
}

describe('HX711 (24-bit load-cell ADC, bit-banged)', () => {
  it('idles DT LOW to signal data-ready', () => {
    const h = new Hx711('h', DT, SCK);
    const host = new MockCircuitHost();
    h.attach(host);
    expect(host.driven.get(DT)).toBe('low');
  });

  it('clocks out the configured reading MSB-first over 24 pulses', () => {
    const h = new Hx711('h', DT, SCK);
    const host = new MockCircuitHost();
    h.attach(host);
    h.setRaw(0xabcdef);
    expect(readFrame(h, host)).toBe(0xabcdef);
  });

  it('starts a fresh frame on the next read', () => {
    const h = new Hx711('h', DT, SCK);
    const host = new MockCircuitHost();
    h.attach(host);
    h.setRaw(0x0f0f0f);
    expect(readFrame(h, host)).toBe(0x0f0f0f);
    h.setRaw(0x123456);
    host.advance(1_000_000); // idle gap between readings
    expect(readFrame(h, host)).toBe(0x123456);
  });

  it('sign-extends the 24-bit reading', () => {
    const h = new Hx711('h', DT, SCK);
    h.setRaw(0xffffff);
    expect(h.rawValue).toBe(-1);
    h.setRaw(0x800000);
    expect(h.rawValue).toBe(-8388608);
  });
});
