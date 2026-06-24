/**
 * Waveform geometry — pure functions that turn a SignalTrace into drawable points for
 * a given viewport. Runs inside the OffscreenCanvas worker (invariant I2); kept pure
 * so it unit-tests without a canvas. Digital signals render as a step waveform; analog
 * traces (ADC, PWM duty) render as a polyline scaled to the value range.
 */

import type { SignalTrace } from './signal-trace.js';

export interface Viewport {
  startNs: number;
  endNs: number;
  width: number; // px
  height: number; // px
}

export interface Point {
  x: number;
  y: number;
}

function timeToX(tNs: number, vp: Viewport): number {
  const span = vp.endNs - vp.startNs || 1;
  return ((tNs - vp.startNs) / span) * vp.width;
}

/**
 * Digital step waveform: y = top for HIGH, bottom for LOW, with vertical edges at each
 * transition. `padding` keeps the trace off the channel border.
 */
export function digitalStepPolyline(trace: SignalTrace, vp: Viewport, padding = 2): Point[] {
  const yHigh = padding;
  const yLow = vp.height - padding;
  const ts = trace.transitionsInWindow(vp.startNs, vp.endNs);
  const pts: Point[] = [];
  let y = trace.valueAt(vp.startNs) ? yHigh : yLow;
  pts.push({ x: 0, y });
  for (const t of ts) {
    const x = Math.max(0, Math.min(vp.width, timeToX(t.tNs, vp)));
    pts.push({ x, y }); // horizontal to the edge
    y = t.value ? yHigh : yLow;
    pts.push({ x, y }); // vertical edge
  }
  pts.push({ x: vp.width, y }); // extend to the right margin
  return pts;
}

/**
 * Analog polyline: map each transition's value (clamped to [min,max]) to a y, drawn as
 * a sample-and-hold step (ADC/PWM-duty are piecewise-constant between updates).
 */
export function analogPolyline(
  trace: SignalTrace,
  vp: Viewport,
  range: { min: number; max: number },
  padding = 2,
): Point[] {
  const span = range.max - range.min || 1;
  const valueToY = (v: number): number => {
    const f = Math.max(0, Math.min(1, (v - range.min) / span));
    return padding + (1 - f) * (vp.height - 2 * padding);
  };
  const ts = trace.transitionsInWindow(vp.startNs, vp.endNs);
  const pts: Point[] = [];
  let y = valueToY(trace.valueAt(vp.startNs));
  pts.push({ x: 0, y });
  for (const t of ts) {
    const x = Math.max(0, Math.min(vp.width, timeToX(t.tNs, vp)));
    pts.push({ x, y });
    y = valueToY(t.value);
    pts.push({ x, y });
  }
  pts.push({ x: vp.width, y });
  return pts;
}
