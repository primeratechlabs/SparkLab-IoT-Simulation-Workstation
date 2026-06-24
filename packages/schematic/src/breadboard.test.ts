import { describe, it, expect } from 'vitest';
import {
  breadboardHoles,
  breadboardGroupOf,
  breadboardGroups,
  BREADBOARD_COLS,
  BREADBOARD_RAIL_HOLES,
} from './breadboard.js';

describe('breadboard topology', () => {
  it('enumerates every hole (30 columns × 10 rows + 4 rails × 25)', () => {
    const holes = breadboardHoles();
    expect(holes).toHaveLength(BREADBOARD_COLS * 10 + 4 * BREADBOARD_RAIL_HOLES); // 300 + 100 = 400
    expect(new Set(holes).size).toBe(holes.length); // all unique
    expect(holes).toContain('a1');
    expect(holes).toContain('j30');
    expect(holes).toContain('tp1');
    expect(holes).toContain('bn25');
  });

  it('top half {a–e} of a column is one net; bottom half {f–j} is a separate net', () => {
    for (const r of ['a', 'b', 'c', 'd', 'e']) expect(breadboardGroupOf(`${r}7`)).toBe('Tcol7');
    for (const r of ['f', 'g', 'h', 'i', 'j']) expect(breadboardGroupOf(`${r}7`)).toBe('Bcol7');
    // the centre channel isolates top from bottom in the SAME column
    expect(breadboardGroupOf('e7')).not.toBe(breadboardGroupOf('f7'));
    // different columns never share a group
    expect(breadboardGroupOf('a7')).not.toBe(breadboardGroupOf('a8'));
  });

  it('each power rail is one continuous net across all its holes', () => {
    expect(breadboardGroupOf('tp1')).toBe('Trail+');
    expect(breadboardGroupOf('tp25')).toBe('Trail+');
    expect(breadboardGroupOf('tn3')).toBe('Trail-');
    expect(breadboardGroupOf('bp9')).toBe('Brail+');
    expect(breadboardGroupOf('bn12')).toBe('Brail-');
    // the four rails are mutually distinct
    expect(new Set(['Trail+', 'Trail-', 'Brail+', 'Brail-']).size).toBe(4);
  });

  it('breadboardGroups() lists every distinct net, and every hole maps into one of them', () => {
    const groups = new Set(breadboardGroups());
    expect(groups.size).toBe(BREADBOARD_COLS * 2 + 4); // 64
    for (const hole of breadboardHoles())
      expect(groups.has(breadboardGroupOf(hole)), hole).toBe(true);
  });

  it('an unrecognised or out-of-range hole stays isolated (never a phantom net)', () => {
    expect(breadboardGroupOf('zzz')).toBe('zzz');
    // a syntactically-valid but out-of-range column must NOT become a group outside breadboardGroups().
    const groups = new Set(breadboardGroups());
    expect(groups.has(breadboardGroupOf('a31'))).toBe(false); // col > 30 → isolated
    expect(breadboardGroupOf('a31')).toBe('a31');
    expect(breadboardGroupOf('a0')).toBe('a0');
    // the in-range boundary still maps correctly.
    expect(breadboardGroupOf('a30')).toBe('Tcol30');
  });
});
