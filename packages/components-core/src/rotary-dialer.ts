import type { CircuitHost, SimComponent } from './sdk.js';

const BREAK_NS = 60_000_000; // pulse dialing: 10 pulses/s, ~60ms break (LOW) …
const MAKE_NS = 40_000_000; // … ~40ms make (open) → MCU pull-up reads HIGH

/**
 * Rotary telephone dialer (pulse dialing). Dialing digit N briefly closes the "off-normal" DIAL contact
 * and emits N LOW pulses on PULSE (the digit 0 sends ten), which the firmware counts on an INPUT_PULLUP
 * pin. Timing is real (≈10 pulses/second) on the virtual clock, so a pulse-counting sketch decodes the
 * dialled digit. The digit to dial is chosen live from the inspector.
 */
export class RotaryDialer implements SimComponent {
  private host: CircuitHost | null = null;
  private dialing = false;
  lastDigit = -1;

  constructor(
    readonly id: string,
    private readonly pulsePin: number,
    private readonly dialPin?: number,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    host.drivePin(this.pulsePin, 'high-z');
    if (this.dialPin !== undefined) host.drivePin(this.dialPin, 'high-z');
  }

  /** Dial a digit 0–9 (ignored while a dial is in progress). */
  dial(digit: number): void {
    const host = this.host;
    if (!host || this.dialing) return;
    const d = Math.max(0, Math.min(9, Math.round(digit)));
    this.lastDigit = d;
    this.dialing = true;
    if (this.dialPin !== undefined) host.drivePin(this.dialPin, 'low'); // off-normal contact closes
    this.pulse(d === 0 ? 10 : d);
  }

  private pulse(remaining: number): void {
    const host = this.host;
    if (!host) return;
    if (remaining <= 0) {
      if (this.dialPin !== undefined) host.drivePin(this.dialPin, 'high-z');
      this.dialing = false;
      return;
    }
    host.drivePin(this.pulsePin, 'low'); // break
    host.schedule(BREAK_NS, () => {
      host.drivePin(this.pulsePin, 'high-z'); // make (pull-up → HIGH)
      host.schedule(MAKE_NS, () => this.pulse(remaining - 1));
    });
  }
}
