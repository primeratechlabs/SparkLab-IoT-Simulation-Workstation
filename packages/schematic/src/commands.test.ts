import { describe, it, expect } from 'vitest';
import { emptyDocument, newComponent } from './document.js';
import {
  addComponent,
  removeComponent,
  moveComponent,
  rotateComponent,
  setProp,
  renameComponent,
  addWire,
  removeWire,
  touch,
} from './commands.js';
import { MCU_REF, type CircuitDocument } from './types.js';

function base(): CircuitDocument {
  const doc = emptyDocument('p', 'c', { now: 0 });
  doc.components.push(newComponent('led1', 'led', 100, 50));
  doc.wires.push({
    id: 'w1',
    from: { component: 'led1', pin: 'anode' },
    to: { component: MCU_REF, pin: 'D13' },
  });
  return doc;
}

describe('commands — immutability', () => {
  it('never mutates the input document', () => {
    const doc = base();
    const before = JSON.stringify(doc);
    addComponent(doc, newComponent('r1', 'resistor', 0, 0));
    moveComponent(doc, 'led1', 9, 9);
    removeComponent(doc, 'led1');
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('commands — components', () => {
  it('addComponent appends', () => {
    const next = addComponent(base(), newComponent('r1', 'resistor', 0, 0));
    expect(next.components.map((c) => c.id)).toEqual(['led1', 'r1']);
  });

  it('removeComponent cascades wires touching it', () => {
    const next = removeComponent(base(), 'led1');
    expect(next.components).toHaveLength(0);
    expect(next.wires).toHaveLength(0); // w1 referenced led1
  });

  it('removeComponent on an unknown id is a no-op (same reference)', () => {
    const doc = base();
    expect(removeComponent(doc, 'ghost')).toBe(doc);
  });

  it('moveComponent + rotateComponent update one component', () => {
    const moved = moveComponent(base(), 'led1', 7, 8);
    expect(moved.components[0]).toMatchObject({ x: 7, y: 8 });
    const rotated = rotateComponent(moved, 'led1', 270);
    expect(rotated.components[0]!.rotation).toBe(270);
  });

  it('setProp merges a single prop', () => {
    const doc = addComponent(base(), newComponent('r1', 'resistor', 0, 0));
    const next = setProp(doc, 'r1', 'ohms', 1000);
    expect(next.components.find((c) => c.id === 'r1')!.props).toEqual({ ohms: 1000 });
  });

  it('renameComponent rewrites wire endpoints', () => {
    const next = renameComponent(base(), 'led1', 'redLed');
    expect(next.components[0]!.id).toBe('redLed');
    expect(next.wires[0]!.from.component).toBe('redLed');
  });
});

describe('commands — wires + meta', () => {
  it('addWire / removeWire', () => {
    const doc = addWire(base(), {
      id: 'w2',
      from: { component: 'led1', pin: 'cathode' },
      to: { component: MCU_REF, pin: 'GND' },
    });
    expect(doc.wires.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(removeWire(doc, 'w1').wires.map((w) => w.id)).toEqual(['w2']);
  });

  it('touch stamps modifiedAt only', () => {
    const doc = base();
    const next = touch(doc, 12345);
    expect(next.modifiedAt).toBe(12345);
    expect(next.createdAt).toBe(doc.createdAt);
  });
});
