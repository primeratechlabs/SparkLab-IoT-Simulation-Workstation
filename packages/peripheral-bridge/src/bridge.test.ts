import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIntelHex, AVRRunner } from '@sparklab/emulators';
import type { AVRRunner as AVRRunnerType, GpioListener, PortName } from '@sparklab/emulators';
import type { BridgeEvent } from '@sparklab/shared';
import { PeripheralBridge, portBitToPin } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const HEX = join(here, '..', '..', 'emulators', 'test-fixtures', 'blink-uno.hex');

/**
 * Minimal stand-in for AVRRunner that records the GPIO/serial listeners the
 * bridge registers, so a test can drive port changes directly without firmware.
 */
class FakeRunner {
  virtualTimeNs = 0;
  readonly gpioListeners = new Map<PortName, GpioListener>();
  serialListener: ((byte: number) => void) | null = null;

  addGpioListener(port: PortName, listener: GpioListener): void {
    this.gpioListeners.set(port, listener);
  }
  onSerialByte(listener: (byte: number) => void): void {
    this.serialListener = listener;
  }
  /** Simulate a port output change (oldValue is irrelevant to the bridge). */
  fireGpio(port: PortName, value: number): void {
    this.gpioListeners.get(port)?.(value, 0);
  }
  // Unused by these tests but referenced by the bridge's input path.
  setDigitalInput(): void {}
  setAnalogVoltage(): void {}
  serialWrite(): void {}
}

function fakeBridge(): { runner: FakeRunner; bridge: PeripheralBridge } {
  const runner = new FakeRunner();
  const bridge = new PeripheralBridge(runner as unknown as AVRRunnerType);
  return { runner, bridge };
}

describe('PeripheralBridge', () => {
  it('maps ports/bits to Arduino pins', () => {
    expect(portBitToPin('B', 5)).toBe(13); // D13 / LED
    expect(portBitToPin('D', 2)).toBe(2);
    expect(portBitToPin('C', 0)).toBe(14); // A0
    expect(portBitToPin('B', 7)).toBeNull(); // crystal pin
  });

  it('emits virtual-time gpio_write for the LED and uart_tx for Serial', () => {
    const { bytes } = parseIntelHex(readFileSync(HEX, 'utf8'));
    const runner = new AVRRunner(bytes);
    const bridge = new PeripheralBridge(runner);

    const ledWrites: BridgeEvent[] = [];
    let serial = '';
    bridge.onEvent((e) => {
      if (e.type === 'gpio_write' && e.pin === 13) ledWrites.push(e);
      if (e.type === 'uart_tx') serial += String.fromCharCode(...e.bytes);
    });
    bridge.start();

    runner.executeForMillis(2300);

    // LED toggled at least HIGH→LOW→HIGH, each event carries a virtual timestamp.
    expect(ledWrites.length).toBeGreaterThanOrEqual(2);
    expect(ledWrites.every((e) => typeof e.t === 'number' && e.t >= 0)).toBe(true);
    expect(serial).toContain('blink on');
  }, 30_000);

  it('applies a button press (gpio_input) into the emulator', () => {
    const { bytes } = parseIntelHex(readFileSync(HEX, 'utf8'));
    const runner = new AVRRunner(bytes);
    const bridge = new PeripheralBridge(runner);
    // Should not throw; drives the input register for D2.
    bridge.applyInput({ t: 0, type: 'gpio_input', pin: 2, value: 1 });
    bridge.applyInput({ t: 0, type: 'adc_value', pin: 0, raw: 512 });
    expect(runner.cpu.cycles).toBe(0);
  });

  it('adc_value changes the ADC channel voltage (channel form and Arduino A-pin form)', () => {
    const { bytes } = parseIntelHex(readFileSync(HEX, 'utf8'));
    const runner = new AVRRunner(bytes);
    const bridge = new PeripheralBridge(runner);

    // Channel form: pin 0 → channel 0, raw 1023 → full-scale 5V.
    bridge.applyInput({ t: 0, type: 'adc_value', pin: 0, raw: 1023 });
    expect(runner.adc.channelValues[0]).toBeCloseTo(5, 5);

    // Arduino analog-pin form: A2 = digital pin 16 → channel 2.
    // Before the pin→channel fix this passed 16 straight to setAnalogVoltage,
    // which rejects channels > 7 and threw "ADC channel out of range".
    bridge.applyInput({ t: 0, type: 'adc_value', pin: 16, raw: 512 });
    expect(runner.adc.channelValues[2]).toBeCloseTo((512 / 1023) * 5, 5);
    // Other channels untouched.
    expect(runner.adc.channelValues[1] ?? 0).toBe(0);
  });

  it('tracks gpio_write events on ports B, C and D', () => {
    const { runner, bridge } = fakeBridge();
    const writes: BridgeEvent[] = [];
    bridge.onEvent((e) => {
      if (e.type === 'gpio_write') writes.push(e);
    });
    bridge.start();

    runner.fireGpio('D', 0b0000_0100); // D2 high
    runner.fireGpio('C', 0b0000_0001); // PC0 = A0 = pin 14 high
    runner.fireGpio('B', 0b0010_0000); // PB5 = D13 high

    expect(writes).toEqual([
      { t: 0, type: 'gpio_write', pin: 2, value: 1 },
      { t: 0, type: 'gpio_write', pin: 14, value: 1 },
      { t: 0, type: 'gpio_write', pin: 13, value: 1 },
    ]);

    // A return to low emits the falling edge for the same pin.
    runner.fireGpio('D', 0b0000_0000);
    expect(writes.at(-1)).toEqual({ t: 0, type: 'gpio_write', pin: 2, value: 0 });
  });

  it('delivers every event to all registered onEvent listeners', () => {
    const { runner, bridge } = fakeBridge();
    const a: BridgeEvent[] = [];
    const b: BridgeEvent[] = [];
    bridge.onEvent((e) => a.push(e));
    bridge.onEvent((e) => b.push(e));
    bridge.start();

    runner.fireGpio('B', 0b0010_0000); // D13 high
    runner.serialListener?.(0x41); // 'A'

    expect(a).toHaveLength(2);
    expect(a).toEqual(b);
    expect(a[1]).toEqual({ t: 0, type: 'uart_tx', port: 0, bytes: [0x41] });
  });

  it('rejects an out-of-range adc_value channel via the runner guard', () => {
    const { bytes } = parseIntelHex(readFileSync(HEX, 'utf8'));
    const runner = new AVRRunner(bytes);
    const bridge = new PeripheralBridge(runner);

    // pin 8 is neither a valid bare channel (0–7) nor an Arduino analog pin (≥14).
    expect(() => bridge.applyInput({ t: 0, type: 'adc_value', pin: 8, raw: 0 })).toThrow();
    // A0–A5 (pins 14–19) all fold into valid channels 0–5.
    expect(() => bridge.applyInput({ t: 0, type: 'adc_value', pin: 19, raw: 0 })).not.toThrow();
    expect(runner.adc.channelValues[5]).toBe(0);
  });
});
