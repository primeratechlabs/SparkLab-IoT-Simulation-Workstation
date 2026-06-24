/**
 * OffscreenCanvas renderer — REFERENCE-SPEC Stage 3 (gate #4). Draws the logic
 * analyzer / waveform inside a Worker so the main thread never touches the hot pixels
 * (invariant I2). Takes a minimal Canvas2D surface (the real CanvasRenderingContext2D
 * satisfies it) so the geometry + draw sequence unit-test with a recording stub.
 */

import type { SignalTrace } from './signal-trace.js';
import {
  digitalStepPolyline,
  analogPolyline,
  type Viewport,
  type Point,
} from './waveform-geometry.js';

/** The subset of CanvasRenderingContext2D the renderer uses. */
export interface Canvas2D {
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  font: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
}

export interface AnalyzerStyle {
  rowHeight: number;
  labelWidth: number;
  background: string;
  trace: string;
  label: string;
}

export const DEFAULT_STYLE: AnalyzerStyle = {
  rowHeight: 28,
  labelWidth: 48,
  background: '#0b1020',
  trace: '#34d399',
  label: '#94a3b8',
};

function strokePolyline(ctx: Canvas2D, pts: Point[], dx: number, dy: number): void {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x + dx, pts[0]!.y + dy);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x + dx, pts[i]!.y + dy);
  ctx.stroke();
}

/**
 * Render a stacked multi-channel logic analyzer: each digital channel as a step
 * waveform in its own row, labelled on the left. `timeWindow` is the [start,end] ns
 * range shown across `width` pixels. Returns the total pixel height drawn.
 */
export function renderLogicAnalyzer(
  ctx: Canvas2D,
  channels: SignalTrace[],
  timeWindow: { startNs: number; endNs: number },
  width: number,
  style: AnalyzerStyle = DEFAULT_STYLE,
): number {
  const height = channels.length * style.rowHeight;
  ctx.fillStyle = style.background;
  ctx.clearRect(0, 0, width, height);

  const plotWidth = width - style.labelWidth;
  channels.forEach((ch, row) => {
    const rowTop = row * style.rowHeight;
    ctx.fillStyle = style.label;
    ctx.font = '11px monospace';
    ctx.fillText(ch.name, 2, rowTop + style.rowHeight / 2 + 4);

    const vp: Viewport = {
      startNs: timeWindow.startNs,
      endNs: timeWindow.endNs,
      width: plotWidth,
      height: style.rowHeight,
    };
    ctx.strokeStyle = style.trace;
    ctx.lineWidth = 1.5;
    strokePolyline(ctx, digitalStepPolyline(ch, vp, 4), style.labelWidth, rowTop);
  });
  return height;
}

/** Render a single analog channel (ADC / PWM duty) scaled to [min,max]. */
export function renderAnalog(
  ctx: Canvas2D,
  channel: SignalTrace,
  timeWindow: { startNs: number; endNs: number },
  width: number,
  height: number,
  range: { min: number; max: number },
  style: AnalyzerStyle = DEFAULT_STYLE,
): void {
  ctx.fillStyle = style.background;
  ctx.clearRect(0, 0, width, height);
  const vp: Viewport = { startNs: timeWindow.startNs, endNs: timeWindow.endNs, width, height };
  ctx.strokeStyle = style.trace;
  ctx.lineWidth = 1.5;
  strokePolyline(ctx, analogPolyline(channel, vp, range, 4), 0, 0);
}
