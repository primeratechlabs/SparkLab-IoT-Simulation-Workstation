import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * LED tied to a GPIO (through a series resistor). Lights when its pin is driven HIGH (common-cathode
 * to GND). Tracks on/off + a toggle count, AND measures PWM brightness: `analogWrite`/Timer PWM drives
 * the pin as a fast square wave, so `brightness` is the HIGH duty fraction (0..1) over a rolling window
 * — 1 = steady on, 0 = steady off, in between = a dimmed/fading LED (CMB-04). Virtual-time, so the
 * duty is wall-speed independent (I3). `tick()` keeps the measure current while the pin holds steady.
 */
const WINDOW_NS = 20_000_000; // 20ms rolling window (≥ ~10 periods of the 490Hz Uno default PWM)

export class Led implements SimComponent {
  on = false;
  toggles = 0;
  /** PWM duty as a 0..1 fraction (brightness). 1 = steady HIGH, 0 = steady LOW. */
  brightness = 0;
  private host: CircuitHost | null = null;
  private level: 'low' | 'high' = 'low';
  private lastNs = 0;
  private highNs = 0;
  private totalNs = 0;

  constructor(
    readonly id: string,
    private readonly pin: number,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    this.level = host.pinLevel(this.pin);
    this.on = this.level === 'high';
    this.brightness = this.on ? 1 : 0;
    this.lastNs = host.now();
    host.watchPin(this.pin, (level) => {
      this.accumulate(host.now()); // close the segment that just ended at the OLD level
      this.level = level;
      const lit = level === 'high';
      if (lit !== this.on) {
        this.on = lit;
        this.toggles++;
      }
    });
  }

  /** Per-instruction refresh so a steady (un-toggling) pin still reports the right brightness. */
  tick(): void {
    if (this.host) this.accumulate(this.host.now());
  }

  private accumulate(now: number): void {
    const dt = now - this.lastNs;
    if (dt <= 0) return;
    if (this.level === 'high') this.highNs += dt;
    this.totalNs += dt;
    this.lastNs = now;
    if (this.totalNs > WINDOW_NS) {
      const scale = WINDOW_NS / this.totalNs; // decay so brightness tracks the RECENT duty
      this.highNs *= scale;
      this.totalNs *= scale;
    }
    this.brightness = this.totalNs > 0 ? this.highNs / this.totalNs : this.on ? 1 : 0;
  }
}
