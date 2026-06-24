import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * LED bar-graph — N independent LEDs (typically 10) on a common bar. Each anode is its own GPIO; a bar
 * lights when its pin is HIGH (cathodes to GND). Level-driven, so wall-speed independent (I3). Exposes
 * the per-bar lit state + a lit count, so a test/UI can read the displayed level (e.g. a VU meter).
 */
export class LedBarGraph implements SimComponent {
  /** Per-bar lit state, index 0 = first anode. */
  readonly lit: boolean[];
  private host: CircuitHost | null = null;

  constructor(
    readonly id: string,
    private readonly anodes: (number | undefined)[],
  ) {
    this.lit = anodes.map(() => false);
  }

  /** Number of bars currently lit. */
  get count(): number {
    return this.lit.reduce((n, on) => n + (on ? 1 : 0), 0);
  }

  attach(host: CircuitHost): void {
    this.host = host;
    this.anodes.forEach((pin, i) => {
      if (pin === undefined) return; // an unwired bar simply never lights (stays index-aligned)
      this.lit[i] = host.pinLevel(pin) === 'high';
      host.watchPin(pin, (level) => {
        this.lit[i] = level === 'high';
      });
    });
  }
}
