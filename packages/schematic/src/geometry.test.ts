import { describe, it, expect } from 'vitest';
import {
  rotateAround,
  pinWorldPosition,
  boardPinWorldPosition,
  componentBounds,
  snapToGrid,
  hitTestPin,
  hitTestComponent,
  allPinHandles,
} from './geometry.js';
import { emptyDocument, newComponent } from './document.js';
import { MCU_REF } from './types.js';

describe('geometry — rotateAround (exact 90° steps)', () => {
  const o = { x: 0, y: 0 };
  it('rotates a unit vector through the quadrants', () => {
    expect(rotateAround({ x: 10, y: 0 }, 90, o)).toEqual({ x: 0, y: 10 });
    expect(rotateAround({ x: 10, y: 0 }, 180, o)).toEqual({ x: -10, y: 0 });
    expect(rotateAround({ x: 10, y: 0 }, 270, o)).toEqual({ x: 0, y: -10 });
    expect(rotateAround({ x: 10, y: 0 }, 0, o)).toEqual({ x: 10, y: 0 });
  });
});

describe('geometry — pin world positions', () => {
  it('places an unrotated LED pin at origin + offset', () => {
    const led = newComponent('led1', 'led', 100, 50); // size 24×36, anode (8,0)
    expect(pinWorldPosition(led, 'anode')).toEqual({ x: 108, y: 50 });
  });

  it('applies 180° rotation around the component centre', () => {
    const led = newComponent('led1', 'led', 100, 50, { rotation: 180 });
    expect(pinWorldPosition(led, 'anode')).toEqual({ x: 116, y: 86 });
  });

  it('returns undefined for an unknown pin', () => {
    expect(pinWorldPosition(newComponent('l', 'led', 0, 0), 'nope')).toBeUndefined();
  });

  it('places a board MCU pin', () => {
    const doc = emptyDocument('p', 'c', { now: 0 }); // board at (0,0)
    expect(boardPinWorldPosition(doc.board, 'D13')).toEqual({ x: 258, y: 0 });
  });
});

describe('geometry — bounds + snap', () => {
  it('bounds an unrotated component to its footprint', () => {
    expect(componentBounds(newComponent('l', 'led', 100, 50))).toEqual({
      x: 100,
      y: 50,
      w: 24,
      h: 36,
    });
  });

  it('swaps + recentres bounds under 90° rotation', () => {
    expect(componentBounds(newComponent('l', 'led', 100, 50, { rotation: 90 }))).toEqual({
      x: 94,
      y: 56,
      w: 36,
      h: 24,
    });
  });

  it('snaps to an 8px grid', () => {
    expect(snapToGrid({ x: 13, y: 5 })).toEqual({ x: 16, y: 8 });
    expect(snapToGrid({ x: 13, y: 5 }, 10)).toEqual({ x: 10, y: 10 });
  });
});

describe('geometry — hit testing', () => {
  function doc() {
    const d = emptyDocument('p', 'c', { now: 0 });
    d.components.push(newComponent('led1', 'led', 100, 50));
    return d;
  }

  it('hits the nearest pin within radius', () => {
    expect(hitTestPin(doc(), { x: 108, y: 52 }, 6)).toEqual({ component: 'led1', pin: 'anode' });
    expect(hitTestPin(doc(), { x: 258, y: 1 }, 6)).toEqual({ component: MCU_REF, pin: 'D13' });
    expect(hitTestPin(doc(), { x: 500, y: 500 }, 6)).toBeUndefined();
  });

  it('hits the topmost component containing a point', () => {
    const d = doc();
    expect(hitTestComponent(d, { x: 110, y: 60 })).toBe('led1');
    expect(hitTestComponent(d, { x: 0, y: 0 })).toBeUndefined();
    // a second component placed over the first wins (drawn on top)
    d.components.push(newComponent('led2', 'led', 100, 50));
    expect(hitTestComponent(d, { x: 110, y: 60 })).toBe('led2');
  });

  it('enumerates all pin handles (board + components)', () => {
    const handles = allPinHandles(doc());
    expect(handles.some((h) => h.ref.component === MCU_REF && h.ref.pin === 'A0')).toBe(true);
    expect(handles.some((h) => h.ref.component === 'led1' && h.ref.pin === 'cathode')).toBe(true);
  });
});
