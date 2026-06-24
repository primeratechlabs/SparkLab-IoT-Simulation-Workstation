import { describe, it, expect } from 'vitest';
import { MockCircuitHost } from './mock-host.js';
import { LedBarGraph } from './led-bar-graph.js';

const ANODES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

describe('LedBarGraph', () => {
  it('lights each bar whose anode is HIGH and counts the level', () => {
    const host = new MockCircuitHost();
    const bar = new LedBarGraph('bar', ANODES);
    bar.attach(host);
    expect(bar.count).toBe(0);
    expect(bar.lit.every((x) => x === false)).toBe(true);

    // drive a VU-meter level of 6 (first six bars on)
    for (let i = 0; i < 6; i++) host.mcuWrite(ANODES[i]!, 'high');
    expect(bar.count).toBe(6);
    expect(bar.lit.slice(0, 6).every((x) => x === true)).toBe(true);
    expect(bar.lit.slice(6).every((x) => x === false)).toBe(true);
  });

  it('tracks live changes per bar (turning one off lowers the count)', () => {
    const host = new MockCircuitHost();
    const bar = new LedBarGraph('bar', ANODES);
    bar.attach(host);
    host.mcuWrite(ANODES[0]!, 'high');
    host.mcuWrite(ANODES[1]!, 'high');
    expect(bar.count).toBe(2);
    host.mcuWrite(ANODES[0]!, 'low');
    expect(bar.lit[0]).toBe(false);
    expect(bar.lit[1]).toBe(true);
    expect(bar.count).toBe(1);
  });

  it('reflects the initial pin levels at attach (not just later edges)', () => {
    const host = new MockCircuitHost();
    host.mcuWrite(ANODES[3]!, 'high'); // pin already HIGH before attach
    const bar = new LedBarGraph('bar', ANODES);
    bar.attach(host);
    expect(bar.lit[3]).toBe(true);
    expect(bar.count).toBe(1);
  });
});
