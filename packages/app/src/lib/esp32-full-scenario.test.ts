import { describe, it, expect } from 'vitest';
import { projectCanvas } from './canvas-to-document';
import { fullScenario } from './esp32-full-scenario.fixture';
import { instantiateAttachedDevices } from '@sparklab/schematic';
import { NetGraph, resolveDigital, resolveAnalog } from '@sparklab/schematic';
import type { Placed, CanvasWire } from '../composables/useCircuitCanvas';

/**
 * Full 13-part ESP32 breadboard scenario, verified through the REAL browser path (projectCanvas →
 * instantiateAttachedDevices). Everything's power+ground is distributed on the breadboard rails, so this
 * proves the sensors (esp. HC-SR04) still resolve + pass readiness when routed THROUGH the rail, and the
 * LED anodes hop their series resistor across breadboard columns to the right MCU pin.
 */
describe('ESP32 full breadboard scenario — instantiates through the rails', () => {
  const { placed, wires } = fullScenario();
  const built = projectCanvas(placed as Placed[], wires as CanvasWire[], 'esp32-devkit');

  it('every drawn wire maps to the netlist (no unmapped endpoints)', () => {
    expect(built.unmapped, JSON.stringify(built.unmapped)).toHaveLength(0);
  });

  it('resolves LED anodes through the breadboard column + series resistor to their GPIO', () => {
    const g = new NetGraph(built.doc);
    expect(resolveDigital(g, built.doc, 'led-2', 'anode')).toBe(2); // D2 via col5→resistor→col7
    expect(resolveDigital(g, built.doc, 'led-3', 'anode')).toBe(4); // D4
    expect(resolveDigital(g, built.doc, 'led-4', 'anode')).toBe(5); // D5
    expect(resolveDigital(g, built.doc, 'hcsr04-13', 'trig')).toBe(25);
    expect(resolveDigital(g, built.doc, 'hcsr04-13', 'echo')).toBe(26);
    expect(resolveAnalog(g, built.doc, 'ldr-10', 'sig')).toBe(6); // D34 → ADC ch6
  });

  it('instantiates all 9 active devices (3 LED + 2 button + LDR + 2 servo + HC-SR04), no issues', () => {
    const { devices, issues } = instantiateAttachedDevices(built.doc);
    expect(issues, JSON.stringify(issues)).toHaveLength(0);
    const ids = devices.map((d) => d.id).sort();
    expect(ids).toEqual(
      ['button-8', 'button-9', 'hcsr04-13', 'ldr-10', 'led-2', 'led-3', 'led-4', 'servo-11', 'servo-12'].sort(),
    );
    // HC-SR04 specifically — its VCC/GND come through the breadboard '+'/'-' rails, not a direct board pin.
    expect(ids).toContain('hcsr04-13');
  });
});
