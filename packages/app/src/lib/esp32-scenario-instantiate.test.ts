import { describe, it, expect } from 'vitest';
import { projectCanvas } from './canvas-to-document';
import { instantiateAttachedDevices } from '@sparklab/schematic';
import type { Placed, CanvasWire } from '../composables/useCircuitCanvas';

/**
 * Reproduces the BROWSER device-runtime path exactly: the drawn canvas (wokwi pin names) → projectCanvas →
 * CircuitDocument → instantiateAttachedDevices. An ESP32 HC-SR04/LDR wired to VIN/3V3/GND.1/GND.2 must
 * instantiate (this is what the sim worker attaches). Catches doc-building/aliasing mismatches the raw
 * schematic-doc test can't.
 */
const placed: Placed[] = [
  { cid: 'hcsr04-1', type: 'hcsr04', tag: 'wokwi-hc-sr04', x: 460, y: 90, rot: 0, flip: false, props: { distanceCm: 20 } },
  { cid: 'ldr-2', type: 'ldr', tag: 'wokwi-photoresistor-sensor', x: 460, y: 200, rot: 0, flip: false, props: { rFixedOhms: 10000 } },
];
const B = '__board__';
const wires: CanvasWire[] = [
  { id: 'w1', from: { cid: 'hcsr04-1', pin: 'TRIG' }, to: { cid: B, pin: 'D25' }, points: [] },
  { id: 'w2', from: { cid: 'hcsr04-1', pin: 'ECHO' }, to: { cid: B, pin: 'D26' }, points: [] },
  { id: 'w3', from: { cid: 'hcsr04-1', pin: 'VCC' }, to: { cid: B, pin: 'VIN' }, points: [] },
  { id: 'w4', from: { cid: 'hcsr04-1', pin: 'GND' }, to: { cid: B, pin: 'GND.1' }, points: [] },
  { id: 'w5', from: { cid: 'ldr-2', pin: 'AO' }, to: { cid: B, pin: 'D34' }, points: [] },
  { id: 'w6', from: { cid: 'ldr-2', pin: 'VCC' }, to: { cid: B, pin: '3V3' }, points: [] },
  { id: 'w7', from: { cid: 'ldr-2', pin: 'GND' }, to: { cid: B, pin: 'GND.2' }, points: [] },
];

describe('ESP32 scenario — browser doc path instantiates its devices', () => {
  it('projectCanvas → instantiateAttachedDevices attaches the HC-SR04 + LDR', () => {
    const { doc, unmapped } = projectCanvas(placed, wires, 'esp32-devkit');
    expect(unmapped, `unmapped: ${JSON.stringify(unmapped)}`).toHaveLength(0);
    const { devices, issues } = instantiateAttachedDevices(doc);
    expect(issues, `issues: ${JSON.stringify(issues)}`).toHaveLength(0);
    expect(devices.map((d) => d.id).sort()).toEqual(['hcsr04-1', 'ldr-2']);
  });
});
