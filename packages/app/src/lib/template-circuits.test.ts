import { describe, it, expect } from 'vitest';
import { componentReadiness } from '@sparklab/schematic';
import { canvasToDocument } from './canvas-to-document';
import type { Placed, CanvasWire } from '../composables/useCircuitCanvas';
import { TEMPLATES } from './boards';
import {
  BUTTON_LED_CANVAS,
  POT_BRIGHT_CANVAS,
  TEMP_SENSOR_CANVAS,
  BLYNK_LED_CANVAS,
} from './template-circuits';

/** Run a template canvas through the product truth engine and return per-component readiness. */
function readiness(canvas: { placed: unknown[]; wires: unknown[] }, boardId = 'arduino-uno') {
  const doc = canvasToDocument(canvas.placed as Placed[], canvas.wires as CanvasWire[], boardId);
  return componentReadiness(doc);
}

describe('template circuits — ERC-complete via the same truth engine the product runs (AUD-005)', () => {
  it('Button + LED: the LED and the button are both wired correctly (ready)', () => {
    const r = readiness(BUTTON_LED_CANVAS);
    expect(r.get('led1')!.ok).toBe(true); // anode via resistor to D13, cathode to GND
    expect(r.get('btn1')!.ok).toBe(true); // a→D2, b→GND
  });

  it('Pot + LED: the LED and the potentiometer are both ready', () => {
    const r = readiness(POT_BRIGHT_CANVAS);
    expect(r.get('led1')!.ok).toBe(true);
    expect(r.get('pot1')!.ok).toBe(true); // wiper→A0, rails to 5V/GND
  });

  it('NTC temperature: the sensor is fully wired (ready)', () => {
    const r = readiness(TEMP_SENSOR_CANVAS);
    expect(r.get('ntc1')!.ok).toBe(true);
  });

  it('Blynk LED: a drawn LED on ESP32-C3 GPIO2 is wired + ready (so a dashboard V0 switch is VISIBLE)', () => {
    const r = readiness(BLYNK_LED_CANVAS, 'esp32-c3-devkitm');
    expect(r.get('led1')!.ok).toBe(true); // anode via resistor to GPIO2, cathode to GND → reflects pins[2]
  });

  it('every template that ships a circuit has ALL of its components ready (no incomplete part)', () => {
    const withCircuit = TEMPLATES.filter((t) => t.canvas);
    expect(withCircuit.length).toBeGreaterThanOrEqual(3);
    for (const t of withCircuit) {
      const r = readiness(t.canvas!, t.boardId);
      for (const [cid, status] of r) {
        expect(status.ok, `${t.id}: component ${cid} should be ERC-ready`).toBe(true);
      }
    }
  });
});
