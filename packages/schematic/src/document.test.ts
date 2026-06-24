import { describe, it, expect } from 'vitest';
import {
  emptyDocument,
  newComponent,
  pinRefExists,
  validateDocument,
  hasErrors,
  isValidComponentId,
} from './document.js';
import { MCU_REF, type CircuitDocument } from './types.js';

describe('document — construction', () => {
  it('emptyDocument defaults to Arduino Uno with injectable time', () => {
    const doc = emptyDocument('p1', 'My circuit', { now: 1000 });
    expect(doc.board.id).toBe('arduino-uno');
    expect(doc.components).toEqual([]);
    expect(doc.wires).toEqual([]);
    expect(doc.createdAt).toBe(1000);
    expect(doc.modifiedAt).toBe(1000);
  });

  it('newComponent pre-fills catalog default props and accepts overrides', () => {
    expect(newComponent('r1', 'resistor', 10, 20).props).toEqual({ ohms: 220 });
    expect(newComponent('r2', 'resistor', 0, 0, { props: { ohms: 1000 } }).props).toEqual({
      ohms: 1000,
    });
    expect(newComponent('l1', 'led', 0, 0, { rotation: 90 }).rotation).toBe(90);
  });
});

/** A small valid circuit: an LED whose anode wires (through a resistor) to D13, cathode to GND. */
function ledCircuit(): CircuitDocument {
  const doc = emptyDocument('p', 'led', { now: 0 });
  doc.components.push(newComponent('led1', 'led', 100, 50));
  doc.components.push(newComponent('r1', 'resistor', 60, 50));
  doc.wires.push({
    id: 'w1',
    from: { component: 'led1', pin: 'anode' },
    to: { component: 'r1', pin: 'a' },
  });
  doc.wires.push({
    id: 'w2',
    from: { component: 'r1', pin: 'b' },
    to: { component: MCU_REF, pin: 'D13' },
  });
  doc.wires.push({
    id: 'w3',
    from: { component: 'led1', pin: 'cathode' },
    to: { component: MCU_REF, pin: 'GND' },
  });
  return doc;
}

describe('document — pinRefExists', () => {
  const doc = ledCircuit();
  it('resolves board MCU pins', () => {
    expect(pinRefExists(doc, { component: MCU_REF, pin: 'D13' })).toBe(true);
    expect(pinRefExists(doc, { component: MCU_REF, pin: 'A0' })).toBe(true);
    expect(pinRefExists(doc, { component: MCU_REF, pin: 'D99' })).toBe(false);
  });
  it('resolves placed component pins', () => {
    expect(pinRefExists(doc, { component: 'led1', pin: 'anode' })).toBe(true);
    expect(pinRefExists(doc, { component: 'led1', pin: 'nope' })).toBe(false);
    expect(pinRefExists(doc, { component: 'ghost', pin: 'a' })).toBe(false);
  });
});

describe('document — validateDocument', () => {
  it('a well-formed circuit has no errors', () => {
    expect(hasErrors(validateDocument(ledCircuit()))).toBe(false);
  });

  it('flags duplicate component ids', () => {
    const doc = ledCircuit();
    doc.components.push(newComponent('led1', 'led', 0, 0)); // dup id
    expect(validateDocument(doc).some((i) => i.code === 'duplicate-id')).toBe(true);
  });

  it("flags the reserved 'mcu' id", () => {
    const doc = ledCircuit();
    doc.components.push(newComponent(MCU_REF, 'led', 0, 0));
    expect(validateDocument(doc).some((i) => i.code === 'reserved-id')).toBe(true);
  });

  it('flags ids with whitespace/control characters', () => {
    expect(isValidComponentId('ok-1')).toBe(true);
    expect(isValidComponentId('bad id')).toBe(false);
    expect(isValidComponentId('')).toBe(false);
    const doc = ledCircuit();
    doc.components.push(newComponent('bad id', 'led', 0, 0));
    expect(validateDocument(doc).some((i) => i.code === 'invalid-id')).toBe(true);
  });

  it('flags unknown component types and boards', () => {
    const doc = ledCircuit();
    doc.components.push(newComponent('x1', 'flux-capacitor', 0, 0));
    doc.board.id = 'commodore-64';
    const issues = validateDocument(doc);
    expect(issues.some((i) => i.code === 'unknown-type')).toBe(true);
    expect(issues.some((i) => i.code === 'unknown-board')).toBe(true);
  });

  it('flags dangling wires and self-wires', () => {
    const doc = ledCircuit();
    doc.wires.push({
      id: 'bad',
      from: { component: 'led1', pin: 'anode' },
      to: { component: MCU_REF, pin: 'D404' },
    });
    doc.wires.push({
      id: 'loop',
      from: { component: 'led1', pin: 'anode' },
      to: { component: 'led1', pin: 'anode' },
    });
    const issues = validateDocument(doc);
    expect(issues.some((i) => i.code === 'dangling-wire')).toBe(true);
    expect(issues.some((i) => i.code === 'self-wire')).toBe(true);
  });

  it('warns (not errors) on a schemaVersion mismatch', () => {
    const doc = ledCircuit();
    doc.schemaVersion = 999;
    const issues = validateDocument(doc);
    expect(issues.some((i) => i.code === 'schema-version' && i.severity === 'warning')).toBe(true);
    expect(hasErrors(issues)).toBe(false);
  });
});
