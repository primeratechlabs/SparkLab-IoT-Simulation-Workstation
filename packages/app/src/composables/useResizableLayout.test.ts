import { describe, it, expect } from 'vitest';
import { dragTo, DEFAULT_EDITOR_FRAC, DEFAULT_SERIAL_PX } from './useResizableLayout';

const RECT = { left: 100, top: 50, width: 1000, height: 800 }; // bottom = 850

describe('useResizableLayout — dragTo (drag math + clamps)', () => {
  it('col: maps cursor X to the editor fraction of the container width', () => {
    expect(dragTo('col', 100 + 300, RECT)).toBeCloseTo(0.3); // 300/1000 from the left edge
    expect(dragTo('col', 100 + 500, RECT)).toBeCloseTo(0.5);
  });

  it('col: clamps the editor fraction to [0.18, 0.6]', () => {
    expect(dragTo('col', 100 + 50, RECT)).toBeCloseTo(0.18); // too far left → min
    expect(dragTo('col', 100 + 950, RECT)).toBeCloseTo(0.6); // too far right → max
  });

  it('row: maps cursor Y to the serial height (distance from the bottom)', () => {
    expect(dragTo('row', 850 - 232, RECT)).toBeCloseTo(232); // 232px above the bottom
    expect(dragTo('row', 850 - 400, RECT)).toBeCloseTo(400);
  });

  it('row: clamps the serial height to [120, height-200]', () => {
    expect(dragTo('row', 850 - 10, RECT)).toBeCloseTo(120); // too short → min
    expect(dragTo('row', 850 - 999, RECT)).toBeCloseTo(600); // height(800) - TOP_MIN(200)
  });

  it('exposes sensible defaults (editor ~1/3, serial 232px)', () => {
    expect(DEFAULT_EDITOR_FRAC).toBeCloseTo(1 / 3);
    expect(DEFAULT_SERIAL_PX).toBe(232);
  });
});
