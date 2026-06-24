import type { CircuitHost, SimComponent } from './sdk.js';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const BIT_THRESHOLD_NS = 625; // 0 ≈ 400ns HIGH, 1 ≈ 800ns HIGH → split at 625ns
const RESET_NS = 50_000; // a LOW gap ≥ 50µs latches the frame and resyncs

/**
 * WS2812 / NeoPixel addressable LED strip on one data pin. The MCU bit-bangs an 800kHz
 * one-wire signal: each bit is a HIGH pulse whose WIDTH encodes the value (~0.4µs = 0,
 * ~0.8µs = 1) followed by a LOW; 24 bits per pixel in G-R-B order, MSB first; a LOW gap
 * ≥ 50µs latches the frame. We decode it the way the LED driver IC does — measure each
 * HIGH pulse width via `host.now()` and assemble pixels — exposing the last complete
 * frame so a test/UI can read the colours.
 *
 * Sub-µs timing: at firmware level the cycle-exact NeoPixel library is needed; the
 * model itself is exercised at the component level. Fidelity: C (see fidelity-ledger).
 */
export class Ws2812 implements SimComponent {
  /** Colours from the last fully-latched frame. */
  pixels: Rgb[] = [];
  private host: CircuitHost | null = null;
  private level: 'low' | 'high' | null = null;
  private riseNs = -1;
  private lastEdgeNs = -1;
  private acc = 0; // current pixel's 24-bit accumulator
  private bits = 0;
  private building: Rgb[] = [];

  constructor(
    readonly id: string,
    private readonly pin: number,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    this.level = host.pinLevel(this.pin);
    host.watchPin(this.pin, (level) => {
      if (level === this.level) return;
      this.level = level;
      const now = host.now();
      if (level === 'high') {
        // A long LOW before this rising edge latches the previous frame.
        if (this.lastEdgeNs >= 0 && now - this.lastEdgeNs >= RESET_NS) this.latch();
        this.riseNs = now;
      } else if (this.riseNs >= 0) {
        const widthNs = now - this.riseNs;
        this.pushBit(widthNs >= BIT_THRESHOLD_NS ? 1 : 0);
      }
      this.lastEdgeNs = now;
    });
  }

  private pushBit(bit: number): void {
    this.acc = ((this.acc << 1) | bit) & 0xffffff;
    if (++this.bits === 24) {
      // 24 bits = GRB.
      this.building.push({
        g: (this.acc >> 16) & 0xff,
        r: (this.acc >> 8) & 0xff,
        b: this.acc & 0xff,
      });
      this.acc = 0;
      this.bits = 0;
    }
  }

  private latch(): void {
    if (this.building.length) this.pixels = this.building;
    this.building = [];
    this.acc = 0;
    this.bits = 0;
  }

  /** Force-latch the frame in progress (e.g. at the end of a run). */
  flush(): void {
    this.latch();
  }
}
