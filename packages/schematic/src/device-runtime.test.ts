/**
 * Device-runtime conformance — the FUTURE-PROOF lock (the user's core ask: a new device can never
 * silently reintroduce the "drawn device not connected to firmware" class). This test FAILS the build
 * if any drawable catalog component lacks a registered runtime model, if a model's kind diverges from
 * the catalog, or if its `reflect()` throws. Paired with the COMPILE-TIME mapped-type lock in
 * device-runtime.ts (adding a catalog entry breaks `DEVICE_RUNTIME`'s type until a model is added).
 */
import { describe, it, expect } from 'vitest';
import { COMPONENT_CATALOG, CATALOG_TYPES, defaultPropsFor, type BuildContext } from './catalog.js';
import {
  DEVICE_RUNTIME,
  reflectDevice,
  isDrawableType,
  instantiateAttachedDevices,
  reflectDevices,
  applyDeviceProp,
} from './device-runtime.js';
import {
  PushButton,
  Potentiometer,
  HcSr04,
  Dht22,
  DigitalSensor,
  AnalogSensor,
} from '@sparklab/components-core';
import { emptyDocument, newComponent } from './document.js';
import { MCU_REF, type CircuitDocument } from './types.js';

/** A stub BuildContext that resolves every pin (so build() yields a live component for any device). */
function stubCtx(type: string): BuildContext {
  return { id: `${type}-0`, props: defaultPropsFor(type), digital: () => 2, analog: () => 0 };
}

// Split via the real classifier (dogfooded) so new passive substrates (e.g. the breadboard) are handled.
const DRAWABLE = CATALOG_TYPES.filter((t) => isDrawableType(t));
const PASSIVE = CATALOG_TYPES.filter((t) => !isDrawableType(t));

describe('device-runtime registry — future-proof conformance', () => {
  it('every drawable catalog component has a runtime model (no device can be added without one)', () => {
    const missing = DRAWABLE.filter((t) => !(t in DEVICE_RUNTIME));
    expect(missing).toEqual([]);
  });

  it('the registry has NO entries beyond the drawable catalog types (no orphans)', () => {
    const orphans = Object.keys(DEVICE_RUNTIME).filter((t) => !DRAWABLE.includes(t));
    expect(orphans).toEqual([]);
  });

  it('passive parts (resistor, breadboard) are netlist-only — they have no runtime model', () => {
    for (const t of PASSIVE) {
      expect(t in DEVICE_RUNTIME).toBe(false);
      expect(isDrawableType(t)).toBe(false);
    }
    expect(PASSIVE).toContain('resistor');
    expect(PASSIVE).toContain('breadboard');
  });

  it('each model.kind matches the catalog kind (no drift between netlist + runtime)', () => {
    for (const t of DRAWABLE) {
      expect(DEVICE_RUNTIME[t as keyof typeof DEVICE_RUNTIME].kind).toBe(
        COMPONENT_CATALOG[t as keyof typeof COMPONENT_CATALOG].kind,
      );
    }
  });

  it('every drawable device builds + reflects without throwing, returning its kind', () => {
    for (const t of DRAWABLE) {
      const comp = COMPONENT_CATALOG[t as keyof typeof COMPONENT_CATALOG].build(stubCtx(t));
      expect(comp, `build() for '${t}' returned null with all pins resolved`).not.toBeNull();
      const reflection = reflectDevice(t, comp!);
      expect(reflection, `reflectDevice('${t}') returned null`).not.toBeNull();
      expect(reflection!.kind).toBe(COMPONENT_CATALOG[t as keyof typeof COMPONENT_CATALOG].kind);
    }
  });

  it('isDrawableType classifies every catalog type', () => {
    for (const t of DRAWABLE) expect(isDrawableType(t)).toBe(true);
    for (const t of PASSIVE) expect(isDrawableType(t)).toBe(false);
    expect(isDrawableType('not-a-real-type')).toBe(false);
  });
});

/** LED through a series resistor to D13; cathode to GND — a valid drawn circuit. */
function ledCircuit(): CircuitDocument {
  const doc = emptyDocument('p', 'c', { now: 0 });
  doc.components.push(newComponent('led1', 'led', 100, 50, { props: { color: 'green' } }));
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

describe('device-runtime bridge — instantiateAttachedDevices + reflectDevices', () => {
  it('turns a drawn document into typed, attachable devices (the missing seam)', () => {
    const { devices, issues } = instantiateAttachedDevices(ledCircuit());
    expect(issues).toEqual([]);
    expect(devices).toHaveLength(1); // resistor is netlist-only, not a device
    expect(devices[0]!.type).toBe('led');
    expect(devices[0]!.id).toBe('led1');
    expect(devices[0]!.component.id).toBe('led1');
  });

  it('reflects attached devices into a cid-keyed snapshot for the UI', () => {
    const { devices } = instantiateAttachedDevices(ledCircuit());
    const snapshot = reflectDevices(devices);
    expect(snapshot.led1).toBeDefined();
    expect(snapshot.led1!.kind).toBe('led');
    expect(snapshot.led1!.on).toBe(false); // not driven yet (no firmware host attached here)
  });

  it('reports an invalid wiring as an issue instead of attaching a misbehaving device', () => {
    const doc = emptyDocument('p', 'c', { now: 0 });
    doc.components.push(newComponent('led1', 'led', 0, 0)); // no GND return → invalid
    doc.wires.push({
      id: 'w',
      from: { component: 'led1', pin: 'anode' },
      to: { component: MCU_REF, pin: 'D13' },
    });
    const { devices, issues } = instantiateAttachedDevices(doc);
    expect(devices).toHaveLength(0);
    expect(issues.length).toBeGreaterThan(0);
  });
});

/**
 * applyDeviceProp delegates to each model's `applyProp` (Move B): a live inspector edit is data-driven
 * per device, NOT a central switch. Every live-editable prop is hot-applicable (returns true) so nothing
 * silently no-ops; a construction-time/unknown prop returns false so the caller rebuilds.
 */
describe('device-runtime — applyDeviceProp (data-driven live edits)', () => {
  it('hot-applies each device’s live prop and reflects the new state', () => {
    const btn = new PushButton('b', 2);
    expect(applyDeviceProp('button', btn, 'pressed', true)).toBe(true);

    const pot = new Potentiometer('p', 0);
    expect(applyDeviceProp('potentiometer', pot, 'position', 0.75)).toBe(true);

    const hc = new HcSr04('h', 9, 10);
    expect(applyDeviceProp('hcsr04', hc, 'distanceCm', 42)).toBe(true);
    expect(hc.distanceCm).toBe(42);

    const dht = new Dht22('d', 4, { tempC: 24, humidity: 55 });
    expect(applyDeviceProp('dht22', dht, 'tempC', 30)).toBe(true); // DHT readings are now live (no rebuild)
    expect(applyDeviceProp('dht22', dht, 'humidity', 80)).toBe(true);

    const pir = new DigitalSensor('m', 2);
    expect(applyDeviceProp('pir', pir, 'motion', true)).toBe(true);
    expect(pir.active).toBe(true);

    const gas = new AnalogSensor('g', 0, { value: 0 });
    expect(applyDeviceProp('gas', gas, 'level', 50)).toBe(true); // 0–100% → 0..1 internal scale

    expect(applyDeviceProp('flame', new AnalogSensor('f', 0, { value: 0 }), 'level', 10)).toBe(
      true,
    );
    expect(applyDeviceProp('tilt', new DigitalSensor('t', 3), 'tilted', true)).toBe(true);
  });

  it('returns false for an unknown prop or a device with no live props (caller rebuilds)', () => {
    expect(applyDeviceProp('button', new PushButton('b', 2), 'color', 'red')).toBe(false);
    expect(applyDeviceProp('led', {} as never, 'color', 'red')).toBe(false); // LED has no applyProp
    expect(applyDeviceProp('not-a-type', {} as never, 'x', 1)).toBe(false);
  });
});
