/**
 * Audit-driven coverage — the edge cases the comprehensive test audit flagged as under-covered:
 * resistor-hop limits, power-rail derivation + shorts, parse trust-boundary extras, I2C address
 * boundaries, EditorSession.rename, net determinism, build guards, unknown-type skipping, and
 * rotation geometry. Kept in one self-contained file so it doesn't churn the existing suites.
 */
import { describe, it, expect } from 'vitest';
import {
  NetGraph,
  resolveDigital,
  documentToNetlist,
  instantiateComponents,
  buildCircuit,
  parseDocument,
  serializeDocument,
  EditorSession,
  pinWorldPosition,
  boardPinWorldPosition,
  hitTestPin,
  emptyDocument,
  newComponent,
  MCU_REF,
  type CircuitDocument,
} from './index.js';
import { coerceI2cAddress } from './coerce.js';

function twoResistorLed(): CircuitDocument {
  const d = emptyDocument('p', 'c', { now: 0 });
  d.components.push(
    newComponent('led1', 'led', 0, 0),
    newComponent('r1', 'resistor', 0, 0),
    newComponent('r2', 'resistor', 0, 0),
  );
  d.wires.push({
    id: 'w1',
    from: { component: 'led1', pin: 'anode' },
    to: { component: 'r1', pin: 'a' },
  });
  d.wires.push({
    id: 'w2',
    from: { component: 'r1', pin: 'b' },
    to: { component: 'r2', pin: 'a' },
  });
  d.wires.push({
    id: 'w3',
    from: { component: 'r2', pin: 'b' },
    to: { component: MCU_REF, pin: 'D13' },
  });
  return d;
}

describe('netgraph — resolution limits', () => {
  it('resolves through at most ONE series resistor (two in series → undefined)', () => {
    const d = twoResistorLed();
    expect(resolveDigital(new NetGraph(d), d, 'led1', 'anode')).toBeUndefined();
  });

  it('nets() is deterministic and cached', () => {
    const d = twoResistorLed();
    const g = new NetGraph(d);
    expect(g.nets()).toBe(g.nets()); // cached reference
    expect(JSON.stringify(new NetGraph(d).nets())).toBe(JSON.stringify(g.nets())); // stable across instances
  });
});

describe('to-netlist — power rails + unknown types', () => {
  it('placeholders when unwired; flags a 5V↔GND short (vcc===gnd)', () => {
    const d1 = emptyDocument('p', 'c', { now: 0 });
    d1.components.push(newComponent('led1', 'led', 0, 0), newComponent('r1', 'resistor', 0, 0));
    d1.wires.push({
      id: 'w1',
      from: { component: 'led1', pin: 'anode' },
      to: { component: 'r1', pin: 'a' },
    });
    d1.wires.push({
      id: 'w2',
      from: { component: 'r1', pin: 'b' },
      to: { component: MCU_REF, pin: 'D13' },
    });
    const n1 = documentToNetlist(d1);
    expect(n1.netlist.vccNet).toBe('__vcc__');
    expect(n1.netlist.gndNet).toBe('__gnd__');

    const d2 = emptyDocument('p', 'c', { now: 0 });
    d2.wires.push({
      id: 's',
      from: { component: MCU_REF, pin: '5V' },
      to: { component: MCU_REF, pin: 'GND' },
    });
    const n2 = documentToNetlist(d2);
    expect(n2.netlist.vccNet).toBe(n2.netlist.gndNet);
    expect(n2.erc.some((f) => f.rule === 'power-short')).toBe(true);
  });

  it('skips unknown component types (only the MCU remains)', () => {
    const d = emptyDocument('p', 'c', { now: 0 });
    d.components.push({ id: 'y', type: 'flux-capacitor', x: 0, y: 0, rotation: 0, props: {} });
    expect(documentToNetlist(d).netlist.components.map((c) => c.id)).toEqual([MCU_REF]);
  });
});

describe('serialize — parse trust-boundary extras', () => {
  it('rejects a string rotation and a missing board', () => {
    const j = JSON.parse(serializeDocument(emptyDocument('p', 'c', { now: 0 })));
    expect(() =>
      parseDocument(JSON.stringify({ ...j, board: { ...j.board, rotation: '90' } })),
    ).toThrow(/rotation/);
    const noBoard = { ...j };
    delete noBoard.board;
    expect(() => parseDocument(JSON.stringify(noBoard))).toThrow(/board/);
  });
});

describe('coerce — I2C address boundaries', () => {
  it('accepts 0..127, rejects 128, parses hex strings', () => {
    expect(coerceI2cAddress({ address: 0 }, 0x3c)).toBe(0);
    expect(coerceI2cAddress({ address: 127 }, 0x3c)).toBe(127);
    expect(coerceI2cAddress({ address: 128 }, 0x3c)).toBe(0x3c);
    expect(coerceI2cAddress({ address: '0x3f' }, 0x27)).toBe(0x3f);
  });
});

describe('EditorSession — rename', () => {
  it('returns boolean per outcome, rewrites wire endpoints, fires once on real change', () => {
    const s = EditorSession.create('p', 'c', { now: () => 1 });
    s.addComponent('led', 0, 0); // led1
    s.addComponent('resistor', 0, 0); // resistor1
    s.connect({ component: 'led1', pin: 'anode' }, { component: 'resistor1', pin: 'a' });
    expect(s.rename('led1', 'led1')).toBe(true); // same id → no-op, true
    expect(s.rename('led1', 'resistor1')).toBe(false); // clash
    expect(s.rename('led1', 'bad id')).toBe(false); // invalid charset
    let fired = 0;
    s.subscribe(() => fired++);
    expect(s.rename('led1', 'redLed')).toBe(true);
    expect(fired).toBe(1);
    expect(s.document.components.some((c) => c.id === 'redLed')).toBe(true);
    expect(s.document.wires[0]!.from.component).toBe('redLed');
  });
});

describe('instantiate / build guards', () => {
  it('reports unknown component types and refuses to run a non-AVR board', () => {
    const d = emptyDocument('p', 'c', { now: 0 });
    d.components.push({ id: 'y', type: 'flux-capacitor', x: 0, y: 0, rotation: 0, props: {} });
    expect(instantiateComponents(d).issues.some((i) => i.componentId === 'y')).toBe(true);
    const esp = emptyDocument('p', 'c', { boardId: 'esp32-devkit', now: 0 });
    expect(() => buildCircuit(esp, new Uint8Array(8))).toThrow(/run harness/);
  });
});

describe('geometry — rotation + board pins', () => {
  it('pinWorldPosition under 270°', () => {
    expect(pinWorldPosition(newComponent('l', 'led', 100, 50, { rotation: 270 }), 'anode')).toEqual(
      { x: 94, y: 72 },
    );
  });

  it('board pin world position shifts under board rotation; unknown pin → undefined', () => {
    const doc = emptyDocument('p', 'c', { boardId: 'esp32-c3-devkitm', now: 0 });
    const p0 = boardPinWorldPosition(doc.board, 'GPIO2');
    expect(p0).toBeTruthy();
    doc.board.rotation = 90;
    expect(boardPinWorldPosition(doc.board, 'GPIO2')).not.toEqual(p0);
    expect(boardPinWorldPosition(doc.board, 'NOPE')).toBeUndefined();
  });

  it('hitTestPin misses when nothing is within radius', () => {
    const doc = emptyDocument('p', 'c', { now: 0 });
    doc.components.push(newComponent('led1', 'led', 100, 50));
    expect(hitTestPin(doc, { x: 9000, y: 9000 }, 6)).toBeUndefined();
  });
});
