import { describe, it, expect } from 'vitest';
import { breadboardHoles, breadboardGroupOf } from '@sparklab/schematic';
import { SparklabBreadboardElement, registerBreadboardElement } from './breadboard-element';

describe('<sparklab-breadboard> element', () => {
  it('registers the custom element (idempotent)', () => {
    registerBreadboardElement();
    registerBreadboardElement(); // second call must not throw
    expect(customElements.get('sparklab-breadboard')).toBe(SparklabBreadboardElement);
  });

  it('exposes wokwi-compatible pinInfo for every hole (name + numeric x/y + signals)', () => {
    const el = new SparklabBreadboardElement();
    const pins = el.pinInfo;
    expect(pins).toHaveLength(breadboardHoles().length); // 400
    expect(pins.map((p) => p.name)).toEqual(breadboardHoles()); // names follow the schematic contract
    for (const p of pins) {
      expect(typeof p.x).toBe('number');
      expect(typeof p.y).toBe('number');
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(Array.isArray(p.signals)).toBe(true);
    }
  });

  it('lays holes of the same net-group on a shared line (column = same x, rail = same y)', () => {
    const at = (name: string) => {
      const p = new SparklabBreadboardElement().pinInfo.find((q) => q.name === name)!;
      return { x: p.x, y: p.y };
    };
    // a column's top half {a–e} shares the column x; the centre channel separates it from {f–j}.
    expect(at('a5').x).toBe(at('e5').x);
    expect(at('a5').y).toBeLessThan(at('f5').y);
    expect(breadboardGroupOf('a5')).toBe(breadboardGroupOf('e5'));
    // a power rail's holes share the rail y.
    expect(at('tp1').y).toBe(at('tp5').y);
    expect(breadboardGroupOf('tp1')).toBe(breadboardGroupOf('tp5'));
  });

  it('renders an SVG when connected to the DOM', () => {
    const el = new SparklabBreadboardElement();
    el.connectedCallback();
    expect(el.querySelector('svg')).toBeTruthy();
    expect(el.querySelectorAll('circle').length).toBe(breadboardHoles().length); // one dot per hole
  });
});
