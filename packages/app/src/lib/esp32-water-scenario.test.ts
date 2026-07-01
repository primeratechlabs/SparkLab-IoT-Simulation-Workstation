import { describe, it, expect } from 'vitest';
import { projectCanvas } from './canvas-to-document';
import { waterScenario } from './esp32-water-scenario.fixture';
import { wireColor } from './pin-signal';
import { instantiateAttachedDevices, NetGraph, resolveAnalog } from '@sparklab/schematic';
import type { Placed, CanvasWire } from '../composables/useCircuitCanvas';

/** Water-level sensor scenario: instantiates through the browser doc path, and every wire is coloured by
 *  its electrical role (GND charcoal, power red, signal palette) — including the ones routed via rails. */
describe('ESP32 water-level scenario', () => {
  const { placed, wires } = waterScenario();
  const built = projectCanvas(placed as Placed[], wires as CanvasWire[], 'esp32-devkit');

  it('instantiates the water probe + both warn LEDs through the rails (no unmapped / issues)', () => {
    expect(built.unmapped, JSON.stringify(built.unmapped)).toHaveLength(0);
    const { devices, issues } = instantiateAttachedDevices(built.doc);
    expect(issues, JSON.stringify(issues)).toHaveLength(0);
    expect(devices.map((d) => d.id).sort()).toEqual(['led-hi', 'led-lo', 'water-1']);
  });

  it('the probe signal resolves to the wired ADC channel (D34 → ch6)', () => {
    const g = new NetGraph(built.doc);
    expect(resolveAnalog(g, built.doc, 'water-1', 'sig')).toBe(6);
  });

  it('colours each wire by role (GND=#3B3530, power=#D7503B, signal=palette) — the design convention', () => {
    const colorOf = (id: string) => {
      const i = wires.findIndex((x) => x.id === id);
      const w = wires[i]!;
      return wireColor(w.from.pin, w.to.pin, i);
    };
    // grounds: board GND→rail, probe GND→rail, LED cathodes→rail all charcoal
    expect(colorOf('w2')).toBe('#3B3530'); // GND.1 → tn1
    expect(colorOf('w5')).toBe('#3B3530'); // water GND → tn5
    expect(colorOf('w10')).toBe('#3B3530'); // led-lo C → tn9
    expect(colorOf('w15')).toBe('#3B3530'); // led-hi C → tn17
    // power: 3V3→rail, probe VCC→rail red
    expect(colorOf('w1')).toBe('#D7503B'); // 3V3 → tp1
    expect(colorOf('w4')).toBe('#D7503B'); // water VCC → tp5
    // signals: probe SIG→D34, LED anode/resistor→GPIO from the palette (never GND/power colours)
    for (const id of ['w3', 'w6', 'w7', 'w8', 'w9']) {
      expect(colorOf(id), id).not.toMatch(/#3B3530|#D7503B/);
    }
  });
});
