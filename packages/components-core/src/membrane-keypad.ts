import type { CircuitHost, SimComponent } from './sdk.js';

/** Default 4×4 key labels (row-major), matching the wokwi membrane-keypad. */
export const KEYPAD_4X4 = [
  '1',
  '2',
  '3',
  'A',
  '4',
  '5',
  '6',
  'B',
  '7',
  '8',
  '9',
  'C',
  '*',
  '0',
  '#',
  'D',
];

/**
 * 4×4 matrix membrane keypad. Rows are MCU outputs, columns are MCU inputs (INPUT_PULLUP). A pressed key
 * at (row r, col c) shorts Rr to Cc, so while the scanning firmware drives Rr LOW the model pulls Cc LOW —
 * exactly the matrix the Arduino `Keypad` library (or a hand-rolled row-strobe scan) decodes. The held key
 * is chosen live from the inspector; releasing it lets each column float back HIGH via the MCU pull-up.
 */
export class MembraneKeypad implements SimComponent {
  private host: CircuitHost | null = null;
  private held: { row: number; col: number } | null = null;

  constructor(
    readonly id: string,
    private readonly rows: (number | undefined)[], // R1..R4 → Uno pins
    private readonly cols: (number | undefined)[], // C1..C4 → Uno pins
    private readonly layout: string[] = KEYPAD_4X4,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    for (const r of this.rows) if (r !== undefined) host.watchPin(r, () => this.recompute());
    this.recompute();
  }

  /** Hold a key by its label ('' or unknown = release all). */
  setKey(label: string): void {
    const i = this.layout.indexOf(label);
    this.held = i >= 0 ? { row: Math.floor(i / 4), col: i % 4 } : null;
    this.recompute();
  }

  /** The currently-held key label, or '' if none. */
  get keyLabel(): string {
    return this.held ? (this.layout[this.held.row * 4 + this.held.col] ?? '') : '';
  }

  private recompute(): void {
    const host = this.host;
    if (!host) return;
    // Every column floats (MCU pull-up reads HIGH) unless the held key bridges it to a row driven LOW.
    for (let c = 0; c < this.cols.length; c++) {
      const colPin = this.cols[c];
      if (colPin === undefined) continue;
      const bridged = this.held?.col === c && this.rowLevelLow(this.held.row); // its row is actively driven LOW by the MCU
      host.drivePin(colPin, bridged ? 'low' : 'high-z');
    }
  }

  private rowLevelLow(row: number): boolean {
    const pin = this.rows[row];
    if (pin === undefined || !this.host) return false;
    return !this.host.pinIsReleased(pin) && this.host.pinLevel(pin) === 'low';
  }
}
