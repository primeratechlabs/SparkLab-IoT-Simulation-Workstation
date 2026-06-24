import { describe, it, expect } from 'vitest';
import { SignalTrace, LogicAnalyzer } from './signal-trace.js';

describe('SignalTrace', () => {
  it('records only value changes (edges), not every sample', () => {
    const t = new SignalTrace('D13');
    t.record(0, 0);
    t.record(100, 0); // no change
    t.record(200, 1); // edge
    t.record(300, 1); // no change
    t.record(400, 0); // edge
    expect(t.transitions().map((x) => [x.tNs, x.value])).toEqual([
      [0, 0],
      [200, 1],
      [400, 0],
    ]);
  });

  it('reports the value in effect at any time', () => {
    const t = new SignalTrace('x');
    t.record(100, 1);
    t.record(300, 0);
    expect(t.valueAt(50)).toBe(0); // before first transition
    expect(t.valueAt(100)).toBe(1);
    expect(t.valueAt(200)).toBe(1);
    expect(t.valueAt(400)).toBe(0);
  });

  it('windows transitions with the prior value synthesized at the start edge', () => {
    const t = new SignalTrace('x');
    t.record(0, 0);
    t.record(100, 1);
    t.record(500, 0);
    const w = t.transitionsInWindow(200, 600);
    expect(w[0]).toEqual({ tNs: 200, value: 1 }); // prior HIGH carried into the window
    expect(w.some((x) => x.tNs === 500 && x.value === 0)).toBe(true);
  });

  it('is bounded — old transitions are dropped past capacity (I9)', () => {
    const t = new SignalTrace('x', 100);
    for (let i = 0; i < 1000; i++) t.record(i, i % 2);
    expect(t.count).toBeLessThanOrEqual(100);
    // The most recent transitions survive.
    expect(t.transitions().at(-1)!.tNs).toBe(999);
  });
});

describe('LogicAnalyzer', () => {
  it('captures multiple channels independently', () => {
    const la = new LogicAnalyzer();
    la.record('D2', 0, 1);
    la.record('D13', 0, 0);
    la.record('D13', 100, 1);
    expect(
      la
        .channels()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['D13', 'D2']);
    expect(la.channel('D13').count).toBe(2);
  });

  it('enforces the channel budget', () => {
    const la = new LogicAnalyzer(2);
    la.channel('a');
    la.channel('b');
    expect(() => la.channel('c')).toThrow(/budget/);
  });
});
