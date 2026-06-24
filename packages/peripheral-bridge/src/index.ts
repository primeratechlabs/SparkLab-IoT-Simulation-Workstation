/**
 * Peripheral Bridge (Stage 2 minimal) — REFERENCE-SPEC §12.
 *
 * Translates avr8js peripheral activity into virtual-time BridgeEvents and applies
 * BridgeInputs back into the emulator. Stage 2 covers GPIO (digital), UART TX, and
 * ADC/digital inputs — enough for LED/button/potentiometer/serial. The full
 * event-driven kernel arrives in Stage 3; this is the stable ABI seam.
 */

import type { AVRRunner, PortName } from '@sparklab/emulators';
import type { BridgeEvent, BridgeInput } from '@sparklab/shared';

export * from './abi.js';
export * from './esp32.js';

export type BridgeEventListener = (event: BridgeEvent) => void;

/** Map an AVR port + bit to an Arduino Uno pin number. */
export function portBitToPin(port: PortName, index: number): number | null {
  if (port === 'D') return index >= 0 && index <= 7 ? index : null;
  if (port === 'B') return index >= 0 && index <= 5 ? 8 + index : null; // PB6/PB7 = crystal
  if (port === 'C') return index >= 0 && index <= 5 ? 14 + index : null; // A0..A5
  return null;
}

const WATCHED: PortName[] = ['B', 'C', 'D'];

/**
 * Resolve an `adc_value` input pin to an ATmega328P ADC channel (0–7).
 * Arduino analog pins A0–A5 carry digital pin numbers 14–19, so those are
 * folded down to channels 0–5; values already in 0–7 are treated as the
 * channel directly (the sim worker passes channel 0). Anything else is
 * out of range and reported by the runner's setAnalogVoltage guard.
 */
function adcPinToChannel(pin: number): number {
  return pin >= 14 ? pin - 14 : pin;
}

export class PeripheralBridge {
  private listeners: BridgeEventListener[] = [];
  private prev: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private started = false;

  constructor(private readonly runner: AVRRunner) {}

  onEvent(listener: BridgeEventListener): void {
    this.listeners.push(listener);
  }

  private emit(event: BridgeEvent): void {
    for (const l of this.listeners) l(event);
  }

  /** Attach listeners to the emulator. Call once before running. */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const port of WATCHED) {
      this.runner.addGpioListener(port, (value) => {
        const changed = value ^ this.prev[port];
        this.prev[port] = value;
        if (!changed) return;
        for (let bit = 0; bit < 8; bit++) {
          if (!(changed & (1 << bit))) continue;
          const pin = portBitToPin(port, bit);
          if (pin == null) continue;
          this.emit({
            t: this.runner.virtualTimeNs,
            type: 'gpio_write',
            pin,
            value: (value >> bit) & 1 ? 1 : 0,
          });
        }
      });
    }

    this.runner.onSerialByte((byte) => {
      this.emit({ t: this.runner.virtualTimeNs, type: 'uart_tx', port: 0, bytes: [byte] });
    });
  }

  /** Apply a kernel→emulator input (button press, ADC value, serial RX). */
  applyInput(input: BridgeInput): void {
    switch (input.type) {
      case 'gpio_input':
        this.runner.setDigitalInput(input.pin, input.value === 1);
        break;
      case 'adc_value': {
        // raw is 10-bit (0..1023) against the 5V reference on the Uno.
        // `pin` follows the Arduino convention (A0–A5 = 14–19); fold it down to
        // the ADC channel setAnalogVoltage expects. A bare channel (0–7) passes
        // through unchanged so the sim worker's channel-0 path keeps working.
        const volts = (input.raw / 1023) * 5;
        this.runner.setAnalogVoltage(adcPinToChannel(input.pin), volts);
        break;
      }
      case 'uart_rx':
        for (const b of input.bytes) this.runner.serialWrite(b);
        break;
      default:
        // i2c/spi inputs handled in Stage 3+
        break;
    }
  }
}
