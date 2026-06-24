import type { I2cDevice } from '@sparklab/sim-kernel';
import type { CircuitHost, SimComponent } from './sdk.js';

/**
 * 16x2 character LCD on an I2C backpack (PCF8574 → HD44780 in 4-bit mode). Latches
 * the data nibble (P4–P7) on each Enable (P2) falling edge, with RS = P0, and
 * reassembles RS=1 nibble pairs into displayed characters — so a test/UI can read
 * back exactly what the sketch "printed". Default address 0x27.
 */
export class LcdI2c implements SimComponent, I2cDevice {
  text = '';
  bytes = 0;
  private prevE = 0;
  private pendingHigh: number | null = null;

  constructor(
    readonly id: string,
    private readonly address = 0x27,
  ) {}

  attach(host: CircuitHost): void {
    host.addI2cDevice(this.address, this);
  }

  // ── I2cDevice ──
  startWrite(): boolean {
    return true;
  }
  startRead(): boolean {
    return true;
  }
  read(): number {
    return 0xff;
  }
  stop(): void {}

  write(value: number): boolean {
    this.bytes++;
    const e = (value >> 2) & 1; // P2 = Enable
    if (this.prevE === 1 && e === 0) {
      const nibble = (value >> 4) & 0x0f; // P4–P7 = D4–D7
      const rs = value & 1; // P0 = RS (1 = data/char)
      if (rs === 1) {
        if (this.pendingHigh === null) this.pendingHigh = nibble;
        else {
          this.text += String.fromCharCode((this.pendingHigh << 4) | nibble);
          this.pendingHigh = null;
        }
      } else {
        this.pendingHigh = null; // a command resyncs the nibble pairing
      }
    }
    this.prevE = e;
    return true;
  }
}
