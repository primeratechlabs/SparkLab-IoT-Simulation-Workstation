import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { SevenSegment, type Segment } from './seven-segment.js';

const PINS = { a: 2, b: 3, c: 4, d: 5, e: 6, f: 7, g: 8, dp: 9 };
// which segments form each glyph (a top, b upper-right, c lower-right, d bottom, e lower-left, f upper-left, g mid)
const GLYPH: Record<string, Segment[]> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'd', 'e', 'g'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
};

function show(host: MockCircuitHost, segs: Segment[], on: 'high' | 'low'): void {
  for (const [seg, pin] of Object.entries(PINS))
    host.mcuWrite(pin, segs.includes(seg as Segment) ? on : on === 'high' ? 'low' : 'high');
}

describe('SevenSegment', () => {
  it('decodes the glyph a common-cathode display shows (segment HIGH = lit)', () => {
    const host = new MockCircuitHost();
    const seg = new SevenSegment('s', PINS, { commonCathode: true });
    seg.attach(host);
    expect(seg.digit).toBe(''); // all pins low → nothing lit

    for (const [ch, on] of Object.entries(GLYPH)) {
      show(host, on, 'high');
      expect(seg.digit, `glyph ${ch}`).toBe(ch);
    }
  });

  it('tracks per-segment lit state + the decimal point independently of the digit', () => {
    const host = new MockCircuitHost();
    const seg = new SevenSegment('s', PINS, { commonCathode: true });
    seg.attach(host);
    show(host, GLYPH['1']!, 'high'); // '1' = b,c
    expect(seg.lit.b).toBe(true);
    expect(seg.lit.c).toBe(true);
    expect(seg.lit.a).toBe(false);
    expect(seg.digit).toBe('1');
    host.mcuWrite(PINS.dp, 'high'); // light the decimal point — digit unchanged
    expect(seg.lit.dp).toBe(true);
    expect(seg.digit).toBe('1');
  });

  it('common-anode inverts the drive (segment LOW = lit)', () => {
    const host = new MockCircuitHost();
    const seg = new SevenSegment('s', PINS, { commonCathode: false });
    seg.attach(host);
    show(host, GLYPH['8']!, 'low'); // drive the '8' segments LOW → all lit on a common-anode part
    expect(seg.digit).toBe('8');
  });

  it('reports no glyph for an unrecognised segment pattern', () => {
    const host = new MockCircuitHost();
    const seg = new SevenSegment('s', PINS, { commonCathode: true });
    seg.attach(host);
    host.mcuWrite(PINS.a, 'high'); // just the top bar — not a digit
    host.mcuWrite(PINS.g, 'high');
    expect(seg.digit).toBe('');
  });

  it('a segment pin released to high-z (INPUT) goes dark, even with no level-change callback', () => {
    const host = new MockCircuitHost();
    const seg = new SevenSegment('s', PINS, { commonCathode: true });
    seg.attach(host);
    show(host, GLYPH['8']!, 'high'); // all segments lit → '8'
    expect(seg.digit).toBe('8');
    // firmware reconfigures the 'g' pin to INPUT (high-z); the host fires no watchPin (same logic level).
    host.mcuRelease(PINS.g);
    expect(seg.digit).toBe('8'); // not yet observed (no callback)
    seg.tick(); // the per-instruction tick polls pinIsReleased → g is no longer driven HIGH
    expect(seg.lit.g).toBe(false);
    expect(seg.digit).toBe('0'); // '8' minus the middle bar is the '0' glyph
  });
});
