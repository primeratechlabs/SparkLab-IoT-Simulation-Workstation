import type { CircuitHost, SimComponent } from './sdk.js';
import type { SpiDevice } from '@sparklab/sim-kernel';

const WIDTH = 240;
const HEIGHT = 320;
// ILI9341 command opcodes we decode (the rest — reset/sleep-out/display-on/gamma… — are accepted + ignored).
const CMD_CASET = 0x2a; // column (x) address window
const CMD_PASET = 0x2b; // page (y) address window
const CMD_RAMWR = 0x2c; // memory write (pixel stream follows)

/**
 * ILI9341 240×320 SPI TFT display. Selected by CS (LOW), with a D/C line choosing command vs data. It
 * decodes the core drawing path the Adafruit_GFX / TFT_eSPI drivers use — CASET/PASET set the active
 * window, RAMWR streams RGB565 pixels into it (column then row) — into a framebuffer, so whatever the
 * sketch draws is really rendered. Data reaches it over the shared {@link SpiDevice} bus (hardware
 * MOSI/SCK); the model only needs the CS + D/C GPIOs. Write-path only (MISO returns idle 0xff).
 */
export class Ili9341 implements SimComponent, SpiDevice {
  readonly width = WIDTH;
  readonly height = HEIGHT;
  /** RGB565 framebuffer (0x0000 = black). */
  readonly fb = new Uint16Array(WIDTH * HEIGHT);
  private host: CircuitHost | null = null;
  private hasCs = false;
  private csLow = false;
  private dcData = false; // false = command, true = data
  private cmd = 0;
  private params: number[] = [];
  private win = { xs: 0, ys: 0, xe: WIDTH - 1, ye: HEIGHT - 1 };
  private cx = 0;
  private cy = 0;
  private pixHi = -1; // pending high byte of an RGB565 pixel

  constructor(
    readonly id: string,
    private readonly csPin?: number,
    private readonly dcPin?: number,
  ) {}

  attach(host: CircuitHost): void {
    this.host = host;
    host.addSpiDevice(this);
    if (this.csPin !== undefined) {
      this.hasCs = true;
      host.watchPin(this.csPin, (l) => (this.csLow = l === 'low'));
    }
    if (this.dcPin !== undefined) host.watchPin(this.dcPin, (l) => (this.dcData = l === 'high'));
  }

  /** Selected while CS is LOW; if CS isn't wired (tied to GND) it's a single-device bus → always selected. */
  get selected(): boolean {
    return this.hasCs ? this.csLow : true;
  }

  transfer(mosi: number): number {
    if (!this.selected) return 0xff;
    if (this.dcData) this.onData(mosi);
    else this.onCommand(mosi);
    return 0xff; // write-only display
  }

  private onCommand(b: number): void {
    this.cmd = b & 0xff;
    this.params = [];
    if (this.cmd === CMD_RAMWR) {
      this.cx = this.win.xs;
      this.cy = this.win.ys;
      this.pixHi = -1;
    }
  }

  private onData(b: number): void {
    b &= 0xff;
    if (this.cmd === CMD_CASET || this.cmd === CMD_PASET) {
      this.params.push(b);
      if (this.params.length === 4) {
        const s = (this.params[0]! << 8) | this.params[1]!;
        const e = (this.params[2]! << 8) | this.params[3]!;
        if (this.cmd === CMD_CASET) {
          this.win.xs = s;
          this.win.xe = e;
        } else {
          this.win.ys = s;
          this.win.ye = e;
        }
      }
    } else if (this.cmd === CMD_RAMWR) {
      if (this.pixHi < 0) this.pixHi = b;
      else {
        this.writePixel((this.pixHi << 8) | b);
        this.pixHi = -1;
      }
    }
  }

  private writePixel(rgb565: number): void {
    if (this.cx < WIDTH && this.cy < HEIGHT) this.fb[this.cy * WIDTH + this.cx] = rgb565 & 0xffff;
    if (++this.cx > this.win.xe) {
      this.cx = this.win.xs;
      if (++this.cy > this.win.ye) this.cy = this.win.ys; // wrap the window like the real controller
    }
  }

  /** RGB565 value at (x, y) — for tests + reflection. */
  pixelAt(x: number, y: number): number {
    return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT ? this.fb[y * WIDTH + x]! : 0;
  }

  /** Count of non-black pixels (drawing activity for the UI reflection). */
  get litPixels(): number {
    let n = 0;
    for (const p of this.fb) if (p !== 0) n++;
    return n;
  }
}
