import type { CircuitHost, SimComponent } from './sdk.js';

const GAP_NS = 60_000; // >1 bit-bang period: a SCK rising edge this long after the last starts a new frame
const READY_DELAY_NS = 20_000; // after the 24th data bit, pull DT low again to signal "next sample ready"

/**
 * HX711 24-bit load-cell ADC. Two wires: SCK (clock, MCU→chip) and DT/DOUT (data, chip→MCU). DT idles LOW
 * to say "a conversion is ready"; the firmware then pulses SCK 24 times and, on each rising edge, the chip
 * shifts out one bit of the signed 24-bit reading MSB-first (1–3 extra pulses select the next gain). This
 * is exactly what the bogde `HX711` library bit-bangs, so a sketch reads the configured `raw` value for
 * real. The reading is set live from the inspector (a stand-in for the cell's weight).
 */
export class Hx711 implements SimComponent {
  private host: CircuitHost | null = null;
  private raw = 0x100000; // signed 24-bit reading the chip clocks out (mid-scale-ish default)
  private bit = 0;
  private prevSck: 'low' | 'high' = 'low';
  private lastEdgeNs = -1e18;

  constructor(
    readonly id: string,
    private readonly dtPin: number,
    private readonly sckPin: number,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    host.drivePin(this.dtPin, 'low'); // data ready
    host.watchPin(this.sckPin, (level) => this.onSck(level));
  }

  /** Set the signed 24-bit reading the chip returns (masked to 24 bits). */
  setRaw(value: number): void {
    this.raw = value & 0xffffff;
  }
  get rawValue(): number {
    const v = this.raw & 0xffffff;
    return v & 0x800000 ? v - 0x1000000 : v; // sign-extend 24-bit
  }

  private onSck(level: 'low' | 'high'): void {
    const host = this.host;
    if (!host) return;
    const rising = this.prevSck === 'low' && level === 'high';
    this.prevSck = level;
    if (!rising) return;
    const now = host.now();
    if (this.bit >= 24 || now - this.lastEdgeNs > GAP_NS) this.bit = 0; // new frame
    this.lastEdgeNs = now;
    if (this.bit < 24) {
      const b = (this.raw >> (23 - this.bit)) & 1; // MSB first
      host.drivePin(this.dtPin, b ? 'high' : 'low');
      this.bit++;
      if (this.bit === 24) host.schedule(READY_DELAY_NS, () => host.drivePin(this.dtPin, 'low'));
    }
  }
}
