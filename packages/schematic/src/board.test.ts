import { describe, it, expect } from 'vitest';
import { BOARD_CATALOG, BOARD_TYPES, boardEntry, boardPin, wokwiBoardTagFor } from './board.js';
import { emptyDocument, newComponent } from './document.js';
import { MCU_REF } from './types.js';
import { NetGraph, resolveDigital, resolveAnalog } from './netgraph.js';
import { buildCircuit } from './instantiate.js';

describe('board catalog — three chips', () => {
  it('registers Uno + both ESP32 boards', () => {
    expect(BOARD_TYPES.sort()).toEqual(['arduino-uno', 'esp32-c3-devkitm', 'esp32-devkit']);
    expect(boardEntry('esp32-c3-devkitm')!.architecture).toBe('riscv32');
    expect(boardEntry('esp32-devkit')!.architecture).toBe('xtensa');
  });

  it('Uno: D13 is digital pin 13; A0 is ADC channel 0 (analog-only)', () => {
    expect(boardPin('arduino-uno', 'D13')).toMatchObject({ digitalPin: 13 });
    const a0 = boardPin('arduino-uno', 'A0')!;
    expect(a0.adcChannel).toBe(0);
    expect(a0.digitalPin).toBeUndefined();
  });

  it('ESP32-C3: GPIO2 is dual (digital 2 + ADC ch 2); GPIO18 is digital-only', () => {
    expect(boardPin('esp32-c3-devkitm', 'GPIO2')).toMatchObject({ digitalPin: 2, adcChannel: 2 });
    const g18 = boardPin('esp32-c3-devkitm', 'GPIO18')!;
    expect(g18.digitalPin).toBe(18);
    expect(g18.adcChannel).toBeUndefined();
    expect(boardEntry('esp32-c3-devkitm')!.vccPin).toBe('3V3');
  });

  it('ESP32 classic: D32 is dual (GPIO32 + ADC ch4); VP is ADC-only (no digitalWrite)', () => {
    expect(boardPin('esp32-devkit', 'D32')).toMatchObject({ digitalPin: 32, adcChannel: 4 });
    const vp = boardPin('esp32-devkit', 'VP')!;
    expect(vp.adcChannel).toBe(0);
    expect(vp.digitalPin).toBeUndefined();
  });

  it('maps Uno + ESP32 classic to wokwi board tags; C3 has none', () => {
    expect(wokwiBoardTagFor('arduino-uno')).toBe('wokwi-arduino-uno');
    expect(wokwiBoardTagFor('esp32-devkit')).toBe('wokwi-esp32-devkit-v1');
    expect(wokwiBoardTagFor('esp32-c3-devkitm')).toBeUndefined();
  });

  it('every pin name in a board is unique', () => {
    for (const board of Object.values(BOARD_CATALOG)) {
      const names = board.pins.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('board catalog — resolution targets ESP32 pins', () => {
  it('resolves a pot wiper to an ESP32-C3 ADC channel', () => {
    const doc = emptyDocument('p', 'c', { now: 0, boardId: 'esp32-c3-devkitm' });
    doc.components.push(newComponent('pot', 'potentiometer', 0, 0));
    doc.wires.push({
      id: 'w',
      from: { component: 'pot', pin: 'wiper' },
      to: { component: MCU_REF, pin: 'GPIO2' },
    });
    expect(resolveAnalog(new NetGraph(doc), doc, 'pot', 'wiper')).toBe(2);
  });

  it('resolves an LED to an ESP32-C3 GPIO', () => {
    const doc = emptyDocument('p', 'c', { now: 0, boardId: 'esp32-c3-devkitm' });
    doc.components.push(newComponent('led1', 'led', 0, 0));
    doc.wires.push({
      id: 'w',
      from: { component: 'led1', pin: 'anode' },
      to: { component: MCU_REF, pin: 'GPIO5' },
    });
    expect(resolveDigital(new NetGraph(doc), doc, 'led1', 'anode')).toBe(5);
  });

  it('buildCircuit refuses a non-AVR board (needs its own run harness)', () => {
    const doc = emptyDocument('p', 'c', { now: 0, boardId: 'esp32-c3-devkitm' });
    expect(() => buildCircuit(doc, new Uint8Array(16))).toThrow(/run harness/);
  });
});
