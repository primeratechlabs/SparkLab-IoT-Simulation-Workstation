import { describe, it, expect } from 'vitest';
import { emptyDocument, newComponent } from './document.js';
import { MCU_REF } from './types.js';
import { instantiateComponents } from './instantiate.js';
import { componentReadiness } from './readiness.js';
import { NetGraph, resolveDigital } from './netgraph.js';

/**
 * ESP32 device-runtime instantiation regression. A device wired to the ESP32 DevKit power/ground pins must
 * pass the readiness gate and be instantiated. Doc pins are the CANONICAL board names board.ts declares
 * (VIN / 3V3 / GND) — the same names the canvas→document bridge's aliasBoardPin emits (it folds the wokwi
 * header's GND.1/GND.2 → GND, and leaves VIN as-is). VIN used to be absent from board.ts → a device wired
 * to it failed the "reaches a board power pin" check and was silently dropped ("Thiếu VCC").
 */
function esp32Doc() {
  const doc = emptyDocument('p', 'c', { boardId: 'esp32-devkit', now: 0 });
  doc.components.push(newComponent('hc', 'hcsr04', 100, 50));
  doc.components.push(newComponent('ldr', 'ldr', 200, 50));
  doc.wires.push({ id: 'w1', from: { component: 'hc', pin: 'trig' }, to: { component: MCU_REF, pin: 'D25' } });
  doc.wires.push({ id: 'w2', from: { component: 'hc', pin: 'echo' }, to: { component: MCU_REF, pin: 'D26' } });
  doc.wires.push({ id: 'w3', from: { component: 'hc', pin: 'vcc' }, to: { component: MCU_REF, pin: 'VIN' } });
  doc.wires.push({ id: 'w4', from: { component: 'hc', pin: 'gnd' }, to: { component: MCU_REF, pin: 'GND' } });
  doc.wires.push({ id: 'w5', from: { component: 'ldr', pin: 'sig' }, to: { component: MCU_REF, pin: 'D34' } });
  doc.wires.push({ id: 'w6', from: { component: 'ldr', pin: 'vcc' }, to: { component: MCU_REF, pin: '3V3' } });
  doc.wires.push({ id: 'w7', from: { component: 'ldr', pin: 'gnd' }, to: { component: MCU_REF, pin: 'GND' } });
  return doc;
}

describe('ESP32 device-runtime instantiate', () => {
  it('resolves component pins to the wired ESP32 GPIOs', () => {
    const doc = esp32Doc();
    const g = new NetGraph(doc);
    expect(resolveDigital(g, doc, 'hc', 'trig')).toBe(25);
    expect(resolveDigital(g, doc, 'hc', 'echo')).toBe(26);
  });

  it('passes readiness + instantiates devices wired to VIN / 3V3 / GND', () => {
    const doc = esp32Doc();
    const readiness = componentReadiness(doc);
    expect(readiness.get('hc')?.ok, JSON.stringify(readiness.get('hc'))).toBe(true);
    expect(readiness.get('ldr')?.ok, JSON.stringify(readiness.get('ldr'))).toBe(true);
    const { components, issues } = instantiateComponents(doc);
    expect(issues, JSON.stringify(issues)).toHaveLength(0);
    expect(components.map((c) => c.id).sort()).toEqual(['hc', 'ldr']);
  });
});
