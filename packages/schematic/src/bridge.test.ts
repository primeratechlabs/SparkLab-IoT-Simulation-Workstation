import { describe, it, expect } from 'vitest';
import { Led } from '@sparklab/components-core';
import type { CircuitHost, DriveLevel } from '@sparklab/components-core';
import { emptyDocument, newComponent } from './document.js';
import { MCU_REF, type CircuitDocument } from './types.js';
import { NetGraph, resolveDigital, resolveAnalog } from './netgraph.js';
import { documentToNetlist } from './to-netlist.js';
import { instantiateComponents, buildCircuit } from './instantiate.js';

/** LED through a series resistor to D13; cathode to GND — the canonical breadboard idiom. */
function ledCircuit(): CircuitDocument {
  const doc = emptyDocument('p', 'c', { now: 0 });
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

describe('netgraph — pin resolution', () => {
  it('resolves an LED through a series resistor to its MCU pin (D13 → 13)', () => {
    const doc = ledCircuit();
    expect(resolveDigital(new NetGraph(doc), doc, 'led1', 'anode')).toBe(13);
  });

  it('resolves a direct wire with no resistor (button → D2)', () => {
    const doc = emptyDocument('p', 'c', { now: 0 });
    doc.components.push(newComponent('btn', 'button', 0, 0));
    doc.wires.push({
      id: 'w',
      from: { component: 'btn', pin: 'a' },
      to: { component: MCU_REF, pin: 'D2' },
    });
    expect(resolveDigital(new NetGraph(doc), doc, 'btn', 'a')).toBe(2);
  });

  it('resolves an analog wiper to its ADC channel (A0 → 0)', () => {
    const doc = emptyDocument('p', 'c', { now: 0 });
    doc.components.push(newComponent('pot', 'potentiometer', 0, 0));
    doc.wires.push({
      id: 'w',
      from: { component: 'pot', pin: 'wiper' },
      to: { component: MCU_REF, pin: 'A0' },
    });
    expect(resolveAnalog(new NetGraph(doc), doc, 'pot', 'wiper')).toBe(0);
  });

  it('returns undefined for an unconnected pin', () => {
    const doc = ledCircuit();
    doc.wires = [];
    expect(resolveDigital(new NetGraph(doc), doc, 'led1', 'anode')).toBeUndefined();
  });
});

describe('to-netlist — documentToNetlist + ERC', () => {
  it('builds an MCU + parts netlist with a derived GND rail; clean ERC for a valid LED+R', () => {
    const { netlist, erc } = documentToNetlist(ledCircuit());
    expect(netlist.components.map((c) => c.kind).sort()).toEqual(['led', 'mcu', 'resistor']);
    expect(netlist.components.find((c) => c.id === 'r1')!.ohms).toBe(220);
    const gnd = netlist.nets.find((n) => n.id === netlist.gndNet)!;
    expect(gnd.pins.some((p) => p.component === MCU_REF && p.pin === 'GND')).toBe(true);
    expect(erc).toEqual([]);
  });

  it('flags an LED wired straight to a pin with no series resistor', () => {
    const doc = emptyDocument('p', 'c', { now: 0 });
    doc.components.push(newComponent('led1', 'led', 0, 0));
    doc.wires.push({
      id: 'w1',
      from: { component: 'led1', pin: 'anode' },
      to: { component: MCU_REF, pin: 'D13' },
    });
    doc.wires.push({
      id: 'w2',
      from: { component: 'led1', pin: 'cathode' },
      to: { component: MCU_REF, pin: 'GND' },
    });
    expect(documentToNetlist(doc).erc.some((f) => f.rule === 'led-no-resistor')).toBe(true);
  });

  it('flags 5V→GPIO over-voltage on an ESP32 (3.3V) board, but not on the Uno (5V)', () => {
    const esp = emptyDocument('p', 'c', { boardId: 'esp32-c3-devkitm', now: 0 });
    esp.wires.push({
      id: 'w',
      from: { component: MCU_REF, pin: 'GPIO2' },
      to: { component: MCU_REF, pin: '5V' },
    });
    expect(documentToNetlist(esp).erc.some((f) => f.rule === 'over-voltage')).toBe(true);

    const uno = emptyDocument('p', 'c', { boardId: 'arduino-uno', now: 0 });
    uno.wires.push({
      id: 'w',
      from: { component: MCU_REF, pin: '13' },
      to: { component: MCU_REF, pin: '5V' },
    });
    expect(documentToNetlist(uno).erc.some((f) => f.rule === 'over-voltage')).toBe(false); // AVR is 5V-logic
  });

  it('flags 5V over-voltage on an ESP32 input-only ADC pin (VP/D34), not just digital pins', () => {
    // D34 is an input-only ADC pin (type 'analog', adcChannel 6) — still 3.3V-tolerant, so 5V damages it.
    const esp = emptyDocument('p', 'c', { boardId: 'esp32-devkit', now: 0 });
    esp.wires.push({
      id: 'w',
      from: { component: MCU_REF, pin: 'D34' },
      to: { component: MCU_REF, pin: '5V' },
    });
    expect(documentToNetlist(esp).erc.some((f) => f.rule === 'over-voltage')).toBe(true);
  });

  it('flags an I2C address conflict between two displays sharing a bus', () => {
    const doc = emptyDocument('p', 'c', { now: 0 });
    doc.components.push(newComponent('lcd1', 'lcd-i2c', 0, 0, { props: { address: 0x27 } }));
    doc.components.push(newComponent('lcd2', 'lcd-i2c', 0, 0, { props: { address: 0x27 } }));
    // same physical bus: SDA↔SDA, SCL↔SCL
    doc.wires.push({
      id: 'wsda',
      from: { component: 'lcd1', pin: 'sda' },
      to: { component: 'lcd2', pin: 'sda' },
    });
    doc.wires.push({
      id: 'wscl',
      from: { component: 'lcd1', pin: 'scl' },
      to: { component: 'lcd2', pin: 'scl' },
    });
    expect(documentToNetlist(doc).erc.some((f) => f.rule === 'i2c-address-conflict')).toBe(true);
  });

  it('does NOT flag two unwired I2C displays as a conflict (reports missing bus instead)', () => {
    const doc = emptyDocument('p', 'c', { now: 0 });
    doc.components.push(newComponent('lcd1', 'lcd-i2c', 0, 0, { props: { address: 0x27 } }));
    doc.components.push(newComponent('lcd2', 'lcd-i2c', 0, 0, { props: { address: 0x27 } }));
    const erc = documentToNetlist(doc).erc;
    expect(erc.some((f) => f.rule === 'i2c-address-conflict')).toBe(false);
    expect(erc.filter((f) => f.rule === 'i2c-no-bus')).toHaveLength(2);
  });
});

/** Minimal CircuitHost to prove an instantiated component is wired to the resolved pin. */
class MockHost implements CircuitHost {
  private levels = new Map<number, 'low' | 'high'>();
  private watchers = new Map<number, ((l: 'low' | 'high') => void)[]>();
  now(): number {
    return 0;
  }
  schedule(): number {
    return 0;
  }
  watchPin(pin: number, cb: (l: 'low' | 'high') => void): void {
    const list = this.watchers.get(pin) ?? [];
    list.push(cb);
    this.watchers.set(pin, list);
    cb(this.pinLevel(pin));
  }
  pinIsReleased(): boolean {
    return false;
  }
  pinLevel(pin: number): 'low' | 'high' {
    return this.levels.get(pin) ?? 'low';
  }
  drivePin(_pin: number, _level: DriveLevel): void {}
  setAdcVolts(): void {}
  addI2cDevice(): void {}
  addSpiDevice(): void {}
  set(pin: number, level: 'low' | 'high'): void {
    this.levels.set(pin, level);
    for (const cb of this.watchers.get(pin) ?? []) cb(level);
  }
}

describe('instantiate — runnable components', () => {
  it('builds a Led wired to the resolved pin; resistor is netlist-only (no instance, no issue)', () => {
    const { components, issues } = instantiateComponents(ledCircuit());
    expect(issues).toEqual([]);
    expect(components).toHaveLength(1);
    expect(components[0]).toBeInstanceOf(Led);

    // prove the Led was constructed with pin 13: toggling pin 13 lights it.
    const host = new MockHost();
    const led = components[0] as Led;
    led.attach(host);
    expect(led.on).toBe(false);
    host.set(13, 'high');
    expect(led.on).toBe(true);
  });

  it('reports an issue for a component whose MCU pin cannot be resolved', () => {
    const doc = emptyDocument('p', 'c', { now: 0 });
    doc.components.push(newComponent('led1', 'led', 0, 0)); // not wired
    const { components, issues } = instantiateComponents(doc);
    expect(components).toHaveLength(0);
    expect(issues[0]).toMatchObject({ componentId: 'led1', type: 'led' });
  });
});

describe('buildCircuit — document → runnable Circuit', () => {
  it('assembles a Circuit and runs without throwing (NOP firmware)', () => {
    const { circuit, issues } = buildCircuit(ledCircuit(), new Uint8Array(256));
    expect(issues).toEqual([]);
    expect(() => circuit.run(1)).not.toThrow();
  });
});
