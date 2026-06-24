/**
 * Component SDK — REFERENCE-SPEC Stage 3 (`component-sdk` folded in). The host-API a
 * simulated component is given when it attaches to a circuit: capability-limited
 * access to its pins, the virtual-time scheduler, the ADC and the I2C bus. NO DOM /
 * fetch / OPFS — components only see this surface (the sandbox boundary; a WASM
 * runtime with a watchdog layers on top later for untrusted components).
 */
import type { I2cDevice } from '@sparklab/sim-kernel';

export type DriveLevel = 'low' | 'high' | 'high-z';

/** The circuit-side host a component talks to (pins are Uno pin numbers). */
export interface CircuitHost {
  /** Current virtual time in nanoseconds (the emulator's cycle clock). */
  now(): number;
  /** Schedule `cb` `delayNs` from now on the virtual-time kernel; returns a timer id. */
  schedule(delayNs: number, cb: () => void): number;

  /** Subscribe to MCU-driven level changes on a pin (for outputs → LED etc.). */
  watchPin(pin: number, cb: (level: 'low' | 'high') => void): void;
  /** Has the MCU released the pin (configured as input / high-z)? */
  pinIsReleased(pin: number): boolean;
  /** The logical level the MCU is presenting on a pin. */
  pinLevel(pin: number): 'low' | 'high';
  /** Drive an MCU input pin from the component side ('high-z' = stop driving). */
  drivePin(pin: number, level: DriveLevel): void;

  /** Set the analog voltage on an ADC channel (potentiometer/LDR/NTC). */
  setAdcVolts(channel: number, volts: number): void;
  /** Register an I2C slave device at a 7-bit address. */
  addI2cDevice(address: number, device: I2cDevice): void;
}

/** A simulated component. `attach` wires it to the host; `tick` is an optional
 *  per-instruction hook for sub-microsecond 1-wire/echo timing (sensors only). */
export interface SimComponent {
  readonly id: string;
  attach(host: CircuitHost): void;
  tick?(): void;
}
