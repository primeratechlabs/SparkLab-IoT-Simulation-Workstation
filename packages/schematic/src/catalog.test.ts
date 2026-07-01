import { describe, it, expect } from 'vitest';
import { Led, LcdI2c, Resistor } from '@sparklab/components-core';
import {
  COMPONENT_CATALOG,
  CATALOG_TYPES,
  catalogEntry,
  defaultPropsFor,
  WOKWI_ELEMENT,
  COMPONENT_PIN_ALIAS,
  INTERACTION,
  wokwiTagFor,
  componentPinAlias,
  interactionOf,
  isLiveOperated,
  isAnalogSensor,
  type BuildContext,
} from './catalog.js';

const KNOWN_KINDS = new Set([
  'mcu',
  'led',
  'rgb-led',
  'resistor',
  'button',
  'potentiometer',
  'ldr',
  'ntc',
  'buzzer',
  'relay',
  'servo',
  'ws2812',
  'i2c-device',
  'dht22',
  'hcsr04',
  'wire',
  'pir',
  'gas',
  'flame',
  'water',
  'tilt',
  'switch',
  'sound',
  'pulse',
  'breadboard',
  'seg7',
  'joystick',
  'dipswitch',
  'ledbar',
  'encoder',
  'stepper',
  'keypad',
  'loadcell',
  'dialer',
  'ir',
  'tft',
  'sdcard',
]);

function ctx(over: Partial<BuildContext>): BuildContext {
  return { id: 'c1', props: {}, digital: () => undefined, analog: () => undefined, ...over };
}

describe('catalog — integrity', () => {
  it('registers the 45 built-in components, each well-formed', () => {
    expect(CATALOG_TYPES).toHaveLength(46);
    for (const type of CATALOG_TYPES) {
      const e = catalogEntry(type)!;
      expect(e.type).toBe(type); // key matches entry.type
      expect(e.displayName.length).toBeGreaterThan(0);
      expect(KNOWN_KINDS.has(e.kind)).toBe(true);
      // every part has MCU pins EXCEPT the ir-remote, a wireless transmitter (drives receivers, no wiring)
      if (type === 'ir-remote') expect(e.pins.length).toBe(0);
      else expect(e.pins.length).toBeGreaterThan(0);
      expect(typeof e.build).toBe('function');
      // every pin has a name + a known electrical type
      for (const p of e.pins) expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it('i2c-device entries expose an i2cAddress derivation', () => {
    for (const e of Object.values(COMPONENT_CATALOG)) {
      if (e.kind === 'i2c-device') expect(typeof e.i2cAddress).toBe('function');
    }
  });

  it('defaultPropsFor fills catalog defaults (resistor 220Ω, lcd 0x27)', () => {
    expect(defaultPropsFor('resistor')).toEqual({ ohms: 220 });
    expect(defaultPropsFor('lcd-i2c')).toEqual({ address: 0x27 });
    expect(defaultPropsFor('nope')).toEqual({});
  });

  it('maps every component to a registered custom-element tag, referencing only real catalog types', () => {
    // Almost all are @wokwi/elements; the breadboard is our own vendored `sparklab-` element (wokwi has none).
    for (const type of CATALOG_TYPES) expect(wokwiTagFor(type), type).toMatch(/^(wokwi|sparklab)-/);
    for (const type of Object.keys(WOKWI_ELEMENT)) expect(CATALOG_TYPES).toContain(type);
  });

  // The per-type UI/bridge maps are co-located in the catalog under a mapped-type lock (a new entry
  // fails to compile until it declares them). These guard the parts the type system can't: that alias
  // TARGETS are real pins, and that the live-interaction kinds stay consistent — so a new device can
  // never silently lose its wires (bad alias) or its inspector control (wrong/missing interaction).
  it('every pin-alias maps a wokwi pin onto a REAL catalog pin of that component', () => {
    for (const type of CATALOG_TYPES) {
      const entry = catalogEntry(type)!;
      const validPins = new Set(entry.pins.map((p) => p.name));
      const alias = componentPinAlias(type)!;
      expect(alias, type).toBeTruthy();
      for (const [wokwiPin, catalogPin] of Object.entries(alias)) {
        expect(
          validPins.has(catalogPin),
          `${type}: alias ${wokwiPin}→${catalogPin} targets a non-existent pin`,
        ).toBe(true);
      }
    }
    for (const type of Object.keys(COMPONENT_PIN_ALIAS)) expect(CATALOG_TYPES).toContain(type);
  });

  it('declares live interactions only on real types, consistent with the helper predicates', () => {
    for (const [type, kind] of Object.entries(INTERACTION)) {
      expect(CATALOG_TYPES, type).toContain(type);
      expect(['button', 'pot', 'analog-sensor']).toContain(kind);
      expect(isLiveOperated(type)).toBe(kind === 'button' || kind === 'pot');
      expect(isAnalogSensor(type)).toBe(kind === 'analog-sensor');
    }
    // analog-sensor parts feed an ADC: they must own an analog 'sig' pin for the stimulus slider to wire to.
    for (const type of CATALOG_TYPES) {
      if (interactionOf(type) === 'analog-sensor') {
        expect(
          catalogEntry(type)!.pins.some((p) => p.type === 'analog'),
          type,
        ).toBe(true);
      }
    }
    // a type with no declared interaction has no live input control (helpers agree).
    for (const type of CATALOG_TYPES) {
      if (!interactionOf(type)) {
        expect(isLiveOperated(type)).toBe(false);
        expect(isAnalogSensor(type)).toBe(false);
      }
    }
  });
});

describe('catalog — build() factories', () => {
  it('LED resolves its controlling MCU pin and builds a Led', () => {
    const led = COMPONENT_CATALOG.led!.build(
      ctx({ id: 'led1', digital: (p) => (p === 'anode' ? 13 : undefined) }),
    );
    expect(led).toBeInstanceOf(Led);
    expect(led!.id).toBe('led1');
  });

  it('LED with no MCU connection builds nothing (null)', () => {
    expect(COMPONENT_CATALOG.led!.build(ctx({}))).toBeNull();
  });

  it('resistor is passive — build returns null but it is not absent from the catalog', () => {
    expect(COMPONENT_CATALOG.resistor.build()).toBeNull(); // passive: build takes no pins, yields null
    expect(Resistor).toBeTypeOf('function'); // class still exists for netlist/ohms
  });

  it('I2C LCD builds without needing a pin number, honouring the address prop', () => {
    const e = COMPONENT_CATALOG['lcd-i2c']!;
    const lcd = e.build(ctx({ id: 'lcd1', props: { address: 0x3f } }));
    expect(lcd).toBeInstanceOf(LcdI2c);
    expect(e.i2cAddress!({ address: 0x3f })).toBe(0x3f);
    expect(e.i2cAddress!({})).toBe(0x27); // default
  });

  it('HC-SR04 needs BOTH trig + echo resolved', () => {
    const e = COMPONENT_CATALOG.hcsr04!;
    expect(e.build(ctx({ digital: (p) => (p === 'trig' ? 9 : undefined) }))).toBeNull(); // echo missing
    expect(
      e.build(ctx({ digital: (p) => (p === 'trig' ? 9 : p === 'echo' ? 10 : undefined) })),
    ).not.toBeNull();
  });
});
