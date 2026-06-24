import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * Single-digit 7-segment LED display driven by up to 8 GPIOs (segments a–g + the decimal point dp).
 * Each segment lights per its pin level: common-CATHODE lights on HIGH, common-ANODE on LOW. The model
 * tracks which segments are lit and decodes the standard glyph when the a–g pattern is a known digit
 * (0–9, A–F), so a test/UI can read back "what number the display shows". Purely level-driven — no
 * timing — so it is wall-speed independent (I3).
 */
export type Segment = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'dp';
export interface SevenSegmentPins {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  dp?: number;
}

// a–g bit pattern (a top, b upper-right, c lower-right, d bottom, e lower-left, f upper-left, g middle)
// → the glyph it forms. Lowercase b/d distinguish them from 8/0 on a real 7-seg.
const GLYPHS: Record<string, string> = {
  '1111110': '0',
  '0110000': '1',
  '1101101': '2',
  '1111001': '3',
  '0110011': '4',
  '1011011': '5',
  '1011111': '6',
  '1110000': '7',
  '1111111': '8',
  '1111011': '9',
  '1110111': 'A',
  '0011111': 'b',
  '1001110': 'C',
  '0111101': 'd',
  '1001111': 'E',
  '1000111': 'F',
  '0000000': '',
};

const ORDER: Segment[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];

export class SevenSegment implements SimComponent {
  /** Per-segment lit state (true = glowing). */
  readonly lit: Record<Segment, boolean> = {
    a: false,
    b: false,
    c: false,
    d: false,
    e: false,
    f: false,
    g: false,
    dp: false,
  };
  /** Decoded character ('0'..'9', 'A'..'F'), or '' when the a–g pattern isn't a known glyph. */
  digit = '';
  private host: CircuitHost | null = null;

  constructor(
    readonly id: string,
    private readonly pins: SevenSegmentPins,
    private readonly opts: { commonCathode?: boolean } = {},
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    for (const seg of ORDER) {
      const pin = this.pins[seg];
      if (pin === undefined) continue;
      this.evaluate(seg, pin);
      host.watchPin(pin, () => {
        this.evaluate(seg, pin);
        this.decode();
      });
    }
    this.decode();
  }

  /**
   * Re-read every segment. A pin reconfigured to INPUT (high-z) is NOT actively driven, so its segment
   * goes dark even though `watchPin` never fires for an output→input transition that keeps the same logic
   * level — that release is only visible via `pinIsReleased`, polled here.
   */
  tick(): void {
    if (!this.host) return;
    let changed = false;
    for (const seg of ORDER) {
      const pin = this.pins[seg];
      if (pin === undefined) continue;
      const before = this.lit[seg];
      this.evaluate(seg, pin);
      changed ||= before !== this.lit[seg];
    }
    if (changed) this.decode();
  }

  /** Lit only when the pin is ACTIVELY driven to the active level (high-z is never lit). */
  private evaluate(seg: Segment, pin: number): void {
    const host = this.host;
    if (!host) return;
    if (host.pinIsReleased(pin)) {
      this.lit[seg] = false;
      return;
    }
    const cathode = this.opts.commonCathode ?? true;
    const level = host.pinLevel(pin);
    this.lit[seg] = cathode ? level === 'high' : level === 'low';
  }

  private decode(): void {
    const key = (['a', 'b', 'c', 'd', 'e', 'f', 'g'] as Segment[])
      .map((s) => (this.lit[s] ? '1' : '0'))
      .join('');
    this.digit = GLYPHS[key] ?? '';
  }
}
