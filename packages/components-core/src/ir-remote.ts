import type { CircuitHost, SimComponent } from './sdk.js';
import { IR_RECEIVERS } from './ir-receiver.js';

/**
 * IR remote control — a wireless transmitter with no MCU wiring (like the real thing you point at a
 * sensor). Pressing a key broadcasts its NEC command to every IR receiver in the SAME circuit, which then
 * plays the demodulated frame onto its data pin for the firmware to decode. The key is chosen live from
 * the inspector.
 */
export class IrRemote implements SimComponent {
  private host: CircuitHost | null = null;
  lastKey = -1;

  constructor(readonly id: string) {}

  attach(host: CircuitHost): void {
    this.host = host;
  }

  /** Press a key: send its NEC command (0–255) to all same-circuit receivers. */
  press(command: number, address = 0x00): void {
    const host = this.host;
    if (!host) return;
    this.lastKey = command & 0xff;
    for (const rx of IR_RECEIVERS.get(host) ?? []) rx.receive(command, address);
  }
}
