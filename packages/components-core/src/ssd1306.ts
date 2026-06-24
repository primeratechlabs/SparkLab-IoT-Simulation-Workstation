import type { I2cDevice } from '@sparklab/sim-kernel';
import type { CircuitHost, SimComponent } from './sdk.js';

type AddrMode = 'horizontal' | 'vertical' | 'page';

/**
 * SSD1306 128x64 monochrome OLED on I2C (default address 0x3C). Each I2C write starts
 * with a control byte: 0x00 → the bytes that follow are commands, 0x40 → they are
 * GDDRAM data. The framebuffer is paged: one data byte sets 8 vertical pixels (one
 * column of a page), and the column/page pointers advance per the addressing mode.
 * We decode the subset the Adafruit/u8g2 drivers use (set-address-range + horizontal
 * streaming + page mode) into a real 128x64 bitmap a test/UI can read back.
 */
export class Ssd1306 implements SimComponent, I2cDevice {
  readonly width = 128;
  readonly height = 64;
  /** One byte per (column, page); bit n = pixel at row page*8 + n. */
  readonly buffer = new Uint8Array(128 * 8);

  private firstByte = true;
  private dataMode = false;
  private mode: AddrMode = 'page';
  private col = 0;
  private page = 0;
  private colStart = 0;
  private colEnd = 127;
  private pageStart = 0;
  private pageEnd = 7;
  private cmdArgs: { code: number; need: number; got: number[] } | null = null;

  constructor(
    readonly id: string,
    private readonly address = 0x3c,
  ) {}

  attach(host: CircuitHost): void {
    host.addI2cDevice(this.address, this);
  }

  // ── I2cDevice ──
  startWrite(): boolean {
    this.firstByte = true;
    return true;
  }
  startRead(): boolean {
    return true;
  }
  read(): number {
    return 0x00;
  }
  stop(): void {}

  write(byte: number): boolean {
    if (this.firstByte) {
      this.firstByte = false;
      this.dataMode = (byte & 0x40) !== 0; // D/C# bit
      return true;
    }
    if (this.dataMode) this.writeData(byte);
    else this.command(byte);
    return true;
  }

  // ── readback helpers ──
  isPixelOn(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    return (this.buffer[(y >> 3) * 128 + x]! & (1 << (y & 7))) !== 0;
  }
  litPixels(): number {
    let n = 0;
    for (const b of this.buffer) n += POPCOUNT[b]!;
    return n;
  }

  private command(byte: number): void {
    if (this.cmdArgs) {
      this.cmdArgs.got.push(byte);
      if (this.cmdArgs.got.length >= this.cmdArgs.need) {
        this.applyMultiByte(this.cmdArgs.code, this.cmdArgs.got);
        this.cmdArgs = null;
      }
      return;
    }
    if (byte === 0x20)
      this.cmdArgs = { code: 0x20, need: 1, got: [] }; // memory addr mode
    else if (byte === 0x21)
      this.cmdArgs = { code: 0x21, need: 2, got: [] }; // column range
    else if (byte === 0x22)
      this.cmdArgs = { code: 0x22, need: 2, got: [] }; // page range
    else if (byte >= 0xb0 && byte <= 0xb7)
      this.page = byte - 0xb0; // set page (page mode)
    else if (byte <= 0x0f)
      this.col = (this.col & 0xf0) | (byte & 0x0f); // col low nibble
    else if (byte >= 0x10 && byte <= 0x1f) this.col = (this.col & 0x0f) | ((byte & 0x0f) << 4); // col high
    // other commands (contrast, charge pump, display on/off…) don't change the bitmap
  }

  private applyMultiByte(code: number, args: number[]): void {
    if (code === 0x20)
      this.mode = args[0] === 0 ? 'horizontal' : args[0] === 1 ? 'vertical' : 'page';
    else if (code === 0x21) {
      this.colStart = args[0]! & 0x7f;
      this.colEnd = args[1]! & 0x7f;
      this.col = this.colStart;
    } else if (code === 0x22) {
      this.pageStart = args[0]! & 0x07;
      this.pageEnd = args[1]! & 0x07;
      this.page = this.pageStart;
    }
  }

  private writeData(byte: number): void {
    if (this.col < 128 && this.page < 8) this.buffer[this.page * 128 + this.col] = byte;
    if (this.mode === 'horizontal') {
      if (++this.col > this.colEnd) {
        this.col = this.colStart;
        if (++this.page > this.pageEnd) this.page = this.pageStart;
      }
    } else if (this.mode === 'vertical') {
      if (++this.page > this.pageEnd) {
        this.page = this.pageStart;
        if (++this.col > this.colEnd) this.col = this.colStart;
      }
    } else {
      this.col = (this.col + 1) & 0x7f; // page mode wraps the column at 128
    }
  }
}

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + (POPCOUNT[i >> 1] ?? 0);
