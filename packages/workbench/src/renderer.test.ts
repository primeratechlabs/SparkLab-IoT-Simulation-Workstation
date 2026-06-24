import { describe, it, expect } from 'vitest';
import { SignalTrace } from './signal-trace.js';
import { renderLogicAnalyzer, renderAnalog, type Canvas2D } from './renderer.js';

/** Records the draw calls a renderer makes so we can assert geometry without a canvas. */
class RecordingCtx implements Canvas2D {
  strokeStyle = '';
  fillStyle = '';
  lineWidth = 0;
  font = '';
  calls: string[] = [];
  points: { x: number; y: number }[] = [];
  clearRect(): void {
    this.calls.push('clearRect');
  }
  beginPath(): void {
    this.calls.push('beginPath');
  }
  moveTo(x: number, y: number): void {
    this.calls.push('moveTo');
    this.points.push({ x, y });
  }
  lineTo(x: number, y: number): void {
    this.calls.push('lineTo');
    this.points.push({ x, y });
  }
  stroke(): void {
    this.calls.push('stroke');
  }
  fillText(): void {
    this.calls.push('fillText');
  }
}

describe('renderLogicAnalyzer', () => {
  it('draws one stroked path + label per channel and returns the stacked height', () => {
    const a = new SignalTrace('D13');
    a.record(0, 0);
    a.record(1_000_000_000, 1);
    const b = new SignalTrace('D2');
    b.record(0, 1);
    const ctx = new RecordingCtx();

    const height = renderLogicAnalyzer(ctx, [a, b], { startNs: 0, endNs: 2_000_000_000 }, 200);

    expect(ctx.calls.filter((c) => c === 'stroke')).toHaveLength(2); // one waveform per channel
    expect(ctx.calls.filter((c) => c === 'fillText')).toHaveLength(2); // one label per channel
    expect(height).toBe(2 * 28); // rowHeight default
  });

  it('offsets each channel into its own row and past the label gutter', () => {
    const a = new SignalTrace('x');
    a.record(0, 1);
    const ctx = new RecordingCtx();
    renderLogicAnalyzer(ctx, [a], { startNs: 0, endNs: 1000 }, 100);
    // Every plotted x is ≥ the label width (48); the row is the first (y small).
    for (const p of ctx.points) expect(p.x).toBeGreaterThanOrEqual(48);
  });

  it('renderAnalog strokes a polyline for the channel', () => {
    const a = new SignalTrace('A0');
    a.record(0, 0);
    a.record(500_000_000, 1023);
    const ctx = new RecordingCtx();
    renderAnalog(ctx, a, { startNs: 0, endNs: 1_000_000_000 }, 200, 60, { min: 0, max: 1023 });
    expect(ctx.calls).toContain('stroke');
    expect(ctx.points.length).toBeGreaterThan(1);
  });
});
