import { describe, it, expect } from 'vitest';
import { emptyDocument, newComponent } from './document.js';
import { MCU_REF, type CircuitDocument } from './types.js';
import { componentReadiness } from './readiness.js';
import { instantiateComponents } from './instantiate.js';

const wire = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  from: { component: a[0], pin: a[1] },
  to: { component: b[0], pin: b[1] },
});

function doc(build: (d: CircuitDocument) => void): CircuitDocument {
  const d = emptyDocument('p', 'c', { now: 0 });
  build(d);
  return d;
}

describe('componentReadiness — electrical-topology truth (P1-2/3/4 in the engine)', () => {
  it('LED is ready only with anode→pin (via resistor) AND cathode→GND', () => {
    const complete = doc((d) => {
      d.components.push(newComponent('led1', 'led', 0, 0), newComponent('r1', 'resistor', 0, 0));
      d.wires.push(
        wire('w1', ['led1', 'anode'], ['r1', 'a']),
        wire('w2', ['r1', 'b'], [MCU_REF, 'D13']),
        wire('w3', ['led1', 'cathode'], [MCU_REF, 'GND']),
      );
    });
    expect(componentReadiness(complete).get('led1')).toMatchObject({ ok: true, digital: 13 });
  });

  it('LED with no GND return is NOT ready (and not instantiated)', () => {
    const d = doc((dd) => {
      dd.components.push(newComponent('led1', 'led', 0, 0));
      dd.wires.push(wire('w1', ['led1', 'anode'], [MCU_REF, 'D13']));
    });
    expect(componentReadiness(d).get('led1')).toMatchObject({
      ok: false,
      issues: ['Cathode chưa nối GND'],
    });
    const inst = instantiateComponents(d);
    expect(inst.components).toHaveLength(0);
    expect(inst.issues.some((i) => i.componentId === 'led1')).toBe(true);
  });

  it('LED wired reversed (cathode→pin, anode→GND) is flagged as reversed polarity', () => {
    const d = doc((dd) => {
      dd.components.push(newComponent('led1', 'led', 0, 0));
      dd.wires.push(
        wire('w1', ['led1', 'cathode'], [MCU_REF, 'D13']),
        wire('w2', ['led1', 'anode'], [MCU_REF, 'GND']),
      );
    });
    expect(componentReadiness(d).get('led1')!.issues).toContain(
      'LED đảo cực (anode/cathode ngược)',
    );
  });

  it('analog sensor needs VCC + GND, not just the wiper (potentiometer)', () => {
    const wiperOnly = doc((d) => {
      d.components.push(newComponent('pot1', 'potentiometer', 0, 0));
      d.wires.push(wire('w1', ['pot1', 'wiper'], [MCU_REF, 'A0']));
    });
    expect(componentReadiness(wiperOnly).get('pot1')).toMatchObject({ ok: false });
    expect(componentReadiness(wiperOnly).get('pot1')!.issues).toEqual(
      expect.arrayContaining(['Thiếu VCC', 'Thiếu GND']),
    );

    const full = doc((d) => {
      d.components.push(newComponent('pot1', 'potentiometer', 0, 0));
      d.wires.push(
        wire('w1', ['pot1', 'wiper'], [MCU_REF, 'A0']),
        wire('w2', ['pot1', 'vcc'], [MCU_REF, '5V']),
        wire('w3', ['pot1', 'gnd'], [MCU_REF, 'GND']),
      );
    });
    expect(componentReadiness(full).get('pot1')).toMatchObject({ ok: true, analog: 0 });
  });

  it('WS2812 needs DIN + VCC + GND; DOUT (chain-out) is optional (R2)', () => {
    const dinOnly = doc((d) => {
      d.components.push(newComponent('px', 'ws2812', 0, 0));
      d.wires.push(wire('w1', ['px', 'din'], [MCU_REF, 'D13']));
    });
    expect(componentReadiness(dinOnly).get('px')).toMatchObject({ ok: false });
    const full = doc((d) => {
      d.components.push(newComponent('px', 'ws2812', 0, 0));
      d.wires.push(
        wire('w1', ['px', 'din'], [MCU_REF, 'D13']),
        wire('w2', ['px', 'vcc'], [MCU_REF, '5V']),
        wire('w3', ['px', 'gnd'], [MCU_REF, 'GND']),
      );
    });
    expect(componentReadiness(full).get('px')).toMatchObject({ ok: true, digital: 13 }); // dout unconnected is fine
  });

  it('a bare relay coil is ready with sig + gnd (no separate VCC) (R2)', () => {
    const full = doc((d) => {
      d.components.push(newComponent('rly', 'relay', 0, 0));
      d.wires.push(
        wire('w1', ['rly', 'sig'], [MCU_REF, 'D5']),
        wire('w2', ['rly', 'gnd'], [MCU_REF, 'GND']),
      );
    });
    expect(componentReadiness(full).get('rly')).toMatchObject({ ok: true, digital: 5 });
    const sigOnly = doc((d) => {
      d.components.push(newComponent('rly', 'relay', 0, 0));
      d.wires.push(wire('w1', ['rly', 'sig'], [MCU_REF, 'D5']));
    });
    expect(componentReadiness(sigOnly).get('rly')).toMatchObject({ ok: false }); // missing GND return
  });

  it('I2C device needs SDA + SCL + VCC + GND (A4=SDA, A5=SCL on Uno)', () => {
    const partial = doc((d) => {
      d.components.push(newComponent('lcd1', 'lcd-i2c', 0, 0));
      d.wires.push(wire('w1', ['lcd1', 'sda'], [MCU_REF, 'A4']));
    });
    expect(componentReadiness(partial).get('lcd1')).toMatchObject({ ok: false });

    const full = doc((d) => {
      d.components.push(newComponent('lcd1', 'lcd-i2c', 0, 0));
      d.wires.push(
        wire('w1', ['lcd1', 'sda'], [MCU_REF, 'A4']),
        wire('w2', ['lcd1', 'scl'], [MCU_REF, 'A5']),
        wire('w3', ['lcd1', 'vcc'], [MCU_REF, '5V']),
        wire('w4', ['lcd1', 'gnd'], [MCU_REF, 'GND']),
      );
    });
    expect(componentReadiness(full).get('lcd1')).toMatchObject({ ok: true });
  });
});
