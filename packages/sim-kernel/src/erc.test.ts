import { describe, it, expect } from 'vitest';
import { runErc, type Netlist } from './erc.js';

const base = (over: Partial<Netlist>): Netlist => ({
  components: [],
  nets: [],
  vccNet: 'VCC',
  gndNet: 'GND',
  ...over,
});

describe('ERC', () => {
  it('passes a correctly-wired LED (with series resistor) + pull-up button', () => {
    const nl = base({
      components: [
        { id: 'uno', kind: 'mcu', pinModes: { D13: 'output', D2: 'input_pullup' } },
        { id: 'R1', kind: 'resistor', ohms: 220 },
        { id: 'LED1', kind: 'led' },
        { id: 'BTN', kind: 'button' },
      ],
      nets: [
        {
          id: 'n_led',
          pins: [
            { component: 'uno', pin: 'D13' },
            { component: 'R1', pin: '1' },
          ],
        },
        {
          id: 'n_led2',
          pins: [
            { component: 'R1', pin: '2' },
            { component: 'LED1', pin: 'a' },
          ],
        },
        {
          id: 'GND',
          pins: [
            { component: 'LED1', pin: 'k' },
            { component: 'BTN', pin: '2' },
          ],
        },
        {
          id: 'n_btn',
          pins: [
            { component: 'uno', pin: 'D2' },
            { component: 'BTN', pin: '1' },
          ],
        },
      ],
    });
    expect(runErc(nl)).toHaveLength(0);
  });

  it('flags a power short (low-ohm resistor across VCC↔GND)', () => {
    const nl = base({
      components: [{ id: 'W', kind: 'wire', ohms: 0 }],
      nets: [
        { id: 'VCC', pins: [{ component: 'W', pin: '1' }] },
        { id: 'GND', pins: [{ component: 'W', pin: '2' }] },
      ],
    });
    expect(runErc(nl).map((f) => f.rule)).toContain('power-short');
  });

  it('flags an LED without a series resistor', () => {
    const nl = base({
      components: [
        { id: 'uno', kind: 'mcu', pinModes: { D13: 'output' } },
        { id: 'LED1', kind: 'led' },
      ],
      nets: [
        {
          id: 'n',
          pins: [
            { component: 'uno', pin: 'D13' },
            { component: 'LED1', pin: 'a' },
          ],
        },
        { id: 'GND', pins: [{ component: 'LED1', pin: 'k' }] },
      ],
    });
    const f = runErc(nl);
    expect(f.map((x) => x.rule)).toContain('led-no-resistor');
    expect(f.find((x) => x.rule === 'led-no-resistor')!.severity).toBe('error');
  });

  it('flags an I2C address conflict only for two devices on the SAME bus (P2-1)', () => {
    const nl = base({
      components: [
        { id: 'lcd1', kind: 'i2c-device', address: 0x27 },
        { id: 'lcd2', kind: 'i2c-device', address: 0x27 },
      ],
      nets: [
        {
          id: 'sda',
          pins: [
            { component: 'lcd1', pin: 'sda' },
            { component: 'lcd2', pin: 'sda' },
          ],
        },
        {
          id: 'scl',
          pins: [
            { component: 'lcd1', pin: 'scl' },
            { component: 'lcd2', pin: 'scl' },
          ],
        },
      ],
    });
    const f = runErc(nl).find((x) => x.rule === 'i2c-address-conflict')!;
    expect(f).toBeTruthy();
    expect(f.refs).toEqual(expect.arrayContaining(['lcd1', 'lcd2']));
  });

  it('does NOT flag two same-address devices on INDEPENDENT buses (P2-1)', () => {
    const nl = base({
      components: [
        { id: 'lcd1', kind: 'i2c-device', address: 0x27 },
        { id: 'lcd2', kind: 'i2c-device', address: 0x27 },
      ],
      nets: [
        { id: 'sda1', pins: [{ component: 'lcd1', pin: 'sda' }] },
        { id: 'scl1', pins: [{ component: 'lcd1', pin: 'scl' }] },
        { id: 'sda2', pins: [{ component: 'lcd2', pin: 'sda' }] },
        { id: 'scl2', pins: [{ component: 'lcd2', pin: 'scl' }] },
      ],
    });
    expect(runErc(nl).some((x) => x.rule === 'i2c-address-conflict')).toBe(false);
  });

  it('flags an UNWIRED I2C device as missing bus, not a conflict (P2-1)', () => {
    const nl = base({
      components: [
        { id: 'lcd1', kind: 'i2c-device', address: 0x27 },
        { id: 'lcd2', kind: 'i2c-device', address: 0x27 },
      ],
    });
    const rules = runErc(nl).map((f) => f.rule);
    expect(rules).not.toContain('i2c-address-conflict');
    expect(rules.filter((r) => r === 'i2c-no-bus')).toHaveLength(2);
  });

  it('two devices sharing only SDA (no SCL) are NOT a conflict — a bus needs both lines (R4)', () => {
    const nl = base({
      components: [
        { id: 'lcd1', kind: 'i2c-device', address: 0x27 },
        { id: 'lcd2', kind: 'i2c-device', address: 0x27 },
      ],
      nets: [
        {
          id: 'sda',
          pins: [
            { component: 'lcd1', pin: 'sda' },
            { component: 'lcd2', pin: 'sda' },
          ],
        },
      ], // SCL unwired
    });
    const rules = runErc(nl).map((f) => f.rule);
    expect(rules).not.toContain('i2c-address-conflict');
    expect(rules.filter((r) => r === 'i2c-no-bus')).toHaveLength(2); // both miss SCL → no complete bus
  });

  it('still flags led-no-resistor when the resistor has a floating leg (not in series) (R5)', () => {
    const nl = base({
      components: [
        { id: 'uno', kind: 'mcu', pinModes: { D13: 'output' } },
        { id: 'R1', kind: 'resistor', ohms: 220 },
        { id: 'LED1', kind: 'led' },
      ],
      nets: [
        // R1.1 sits on the SAME net as the LED anode; R1.2 is floating (in no net) → R1 touches 1 net
        {
          id: 'n',
          pins: [
            { component: 'uno', pin: 'D13' },
            { component: 'R1', pin: '1' },
            { component: 'LED1', pin: 'a' },
          ],
        },
        { id: 'GND', pins: [{ component: 'LED1', pin: 'k' }] },
      ],
    });
    expect(runErc(nl).map((f) => f.rule)).toContain('led-no-resistor');
  });

  it('flags a floating input (input mode, nothing driving the net)', () => {
    const nl = base({
      components: [{ id: 'uno', kind: 'mcu', pinModes: { D5: 'input' } }],
      nets: [{ id: 'n_float', pins: [{ component: 'uno', pin: 'D5' }] }],
    });
    expect(runErc(nl).map((f) => f.rule)).toContain('floating-input');
  });

  it('does NOT flag an input_pullup pin as floating', () => {
    const nl = base({
      components: [{ id: 'uno', kind: 'mcu', pinModes: { D5: 'input_pullup' } }],
      nets: [{ id: 'n', pins: [{ component: 'uno', pin: 'D5' }] }],
    });
    expect(runErc(nl).map((f) => f.rule)).not.toContain('floating-input');
  });
});
