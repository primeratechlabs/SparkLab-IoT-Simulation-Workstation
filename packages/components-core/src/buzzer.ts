import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * Passive buzzer / piezo driven by a square wave on a single GPIO (Arduino `tone()`).
 * It has no resonant frequency of its own — the pitch is whatever the MCU toggles, so
 * we recover it from the edge timing: two consecutive opposite edges span a half
 * period, hence `periodNs = 2 · gap` and `freq = 1e9 / periodNs`. `playing` stays true
 * only while edges keep arriving (within `staleNs` of the last one); once the MCU stops
 * toggling (`noTone()` / a steady level) the pin goes silent and the tone reads 0.
 */
export class Buzzer implements SimComponent {
  /** Number of edges (level changes) seen — handy for tests / UI. */
  edges = 0;
  private host: CircuitHost | null = null;
  private level: 'low' | 'high' | null = null;
  private lastEdgeNs = -1; // host time of the most recent edge
  private halfPeriodNs = 0; // gap between the last two edges (= half a period)

  constructor(
    readonly id: string,
    private readonly pin: number,
    /** A tone is considered over if no edge arrives within this window. */
    private readonly staleNs = 2_000_000, // 2ms → tones below ~250Hz still register
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    this.level = host.pinLevel(this.pin);
    host.watchPin(this.pin, (level) => {
      // Only true edges (a change of level) advance the tone estimate; the MCU
      // re-writing the same level is a no-op for a square wave.
      if (level === this.level) return;
      this.level = level;
      this.edges++;
      const now = host.now();
      if (this.lastEdgeNs >= 0) this.halfPeriodNs = now - this.lastEdgeNs;
      this.lastEdgeNs = now;
    });
  }

  /** True while a square wave is still toggling the pin (edges arriving recently). */
  get playing(): boolean {
    if (this.lastEdgeNs < 0 || this.halfPeriodNs <= 0) return false;
    const now = this.host?.now() ?? this.lastEdgeNs;
    return now - this.lastEdgeNs <= this.staleNs;
  }

  /** Estimated tone in Hz, 0 when not playing. */
  get frequencyHz(): number {
    if (!this.playing) return 0;
    return 1e9 / (2 * this.halfPeriodNs);
  }
}
