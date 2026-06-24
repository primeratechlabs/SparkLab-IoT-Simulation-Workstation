import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * DIP switch — N independent SPST switches (typically 8). Each switch's `a` leg goes to an MCU pin
 * (with INPUT_PULLUP) and its `b` leg to GND: closed (ON) ties the line to GND so the firmware reads
 * LOW; open (OFF) releases it so the pull-up reads HIGH. The model drives each `a` pin accordingly.
 * Maintained (not momentary), set live via the inspector. Level-driven → wall-speed independent (I3).
 */
export class DipSwitch implements SimComponent {
  /** Per-switch ON state, index 0 = first switch. */
  readonly on: boolean[];
  private host: CircuitHost | null = null;

  constructor(
    readonly id: string,
    private readonly pins: (number | undefined)[],
    opts: { on?: boolean[] } = {},
  ) {
    this.on = pins.map((_, i) => opts.on?.[i] ?? false);
  }

  attach(host: CircuitHost): void {
    this.host = host;
    this.pins.forEach((_, i) => this.apply(i));
  }

  /** Flip switch `i` (0-based) live; the firmware reads the new level immediately. */
  set(i: number, on: boolean): void {
    if (i < 0 || i >= this.on.length) return;
    this.on[i] = on;
    this.apply(i);
  }

  private apply(i: number): void {
    const pin = this.pins[i];
    if (pin === undefined) return; // an unwired switch drives nothing (stays index-aligned)
    // ON = closed to GND (LOW); OFF = released so the MCU pull-up reads HIGH (high-z).
    this.host?.drivePin(pin, this.on[i] ? 'low' : 'high-z');
  }
}
