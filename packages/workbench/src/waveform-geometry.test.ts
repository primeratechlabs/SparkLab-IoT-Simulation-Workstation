import { describe, it, expect } from 'vitest';
import { SignalTrace } from './signal-trace.js';
import { digitalStepPolyline, analogPolyline } from './waveform-geometry.js';

const vp = { startNs: 0, endNs: 1000, width: 100, height: 20 };

describe('digitalStepPolyline', () => {
  it('renders a square wave as vertical edges at transitions', () => {
    const t = new SignalTrace('x');
    t.record(0, 0);
    t.record(500, 1); // edge at the midpoint → x = 50
    const pts = digitalStepPolyline(t, vp);
    // Starts LOW at the bottom, steps up at x≈50.
    expect(pts[0]).toEqual({ x: 0, y: 18 }); // low (height-2)
    const edge = pts.find((p) => p.x === 50);
    expect(edge).toBeTruthy();
    expect(pts.at(-1)!.x).toBe(100); // extends to the right margin
    expect(pts.at(-1)!.y).toBe(2); // ends HIGH (top)
  });

  it('clamps transitions outside the viewport', () => {
    const t = new SignalTrace('x');
    t.record(-500, 1); // before the window
    t.record(2000, 0); // after the window
    const pts = digitalStepPolyline(t, vp);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(vp.width);
    }
  });
});

describe('analogPolyline', () => {
  it('maps values to y within the range (max → top, min → bottom)', () => {
    const t = new SignalTrace('A0');
    t.record(0, 0);
    t.record(500, 1023);
    const pts = analogPolyline(t, vp, { min: 0, max: 1023 });
    expect(pts[0]!.y).toBeCloseTo(18, 0); // 0 → bottom
    expect(pts.at(-1)!.y).toBeCloseTo(2, 0); // 1023 → top
  });
});
