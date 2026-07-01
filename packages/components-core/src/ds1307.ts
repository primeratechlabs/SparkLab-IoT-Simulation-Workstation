import type { I2cDevice } from '@sparklab/sim-kernel';
import type { CircuitHost, SimComponent } from './sdk.js';

const dec2bcd = (n: number): number => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;
const bcd2dec = (b: number): number => (b >> 4) * 10 + (b & 0x0f);
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * DS1307 real-time clock on I2C (address 0x68). It exposes a 64-byte register file: 0x00–0x06 are the
 * time-keeping registers in BCD (seconds/minutes/hours/day/date/month/year), 0x07 is control, 0x08–0x3F
 * are battery-backed RAM. The master writes a 1-byte register pointer, then either writes data bytes or
 * (after a repeated START) reads — the pointer auto-increments and wraps, exactly like the chip. This is
 * the protocol RTClib's `adjust()` / `now()` and raw `Wire` drive, so a sketch sets and reads the clock
 * for real. With the clock-halt bit clear the time advances one second per virtual second.
 */
export class Ds1307 implements SimComponent, I2cDevice {
  private readonly reg = new Uint8Array(64);
  /** Bounds-safe register read (noUncheckedIndexedAccess); every index here is already masked to 0..63. */
  private rd(i: number): number {
    return this.reg[i] ?? 0;
  }
  private ptr = 0;
  private firstWriteByte = true;
  // structured time we tick + (re)encode to the BCD registers; hours are kept 24h internally.
  private t = { s: 0, mi: 0, h: 0, dow: 1, d: 1, mo: 1, y: 2026 };
  private host: CircuitHost | null = null;

  constructor(
    readonly id: string,
    init: {
      year?: number;
      month?: number;
      date?: number;
      hour?: number;
      minute?: number;
      second?: number;
    } = {},
    private readonly address = 0x68,
  ) {
    this.t = {
      s: init.second ?? 0,
      mi: init.minute ?? 0,
      h: init.hour ?? 12,
      dow: 1,
      d: init.date ?? 1,
      mo: init.month ?? 1,
      y: init.year ?? 2026,
    };
    this.encode();
  }

  attach(host: CircuitHost): void {
    this.host = host;
    host.addI2cDevice(this.address, this);
    this.scheduleTick();
  }

  /** Reschedule a 1-second tick on the virtual clock; advances the time unless the clock-halt bit is set. */
  private scheduleTick(): void {
    this.host?.schedule(1_000_000_000, () => {
      if ((this.rd(0) & 0x80) === 0) this.advanceOneSecond();
      this.scheduleTick();
    });
  }

  private advanceOneSecond(): void {
    // a register write may have moved the time on; pull it back in before advancing.
    this.decode();
    const t = this.t;
    if (++t.s >= 60) {
      t.s = 0;
      if (++t.mi >= 60) {
        t.mi = 0;
        if (++t.h >= 24) {
          t.h = 0;
          t.dow = (t.dow % 7) + 1;
          const dim = t.mo === 2 && isLeap(t.y) ? 29 : (DAYS[t.mo - 1] ?? 31);
          if (++t.d > dim) {
            t.d = 1;
            if (++t.mo > 12) {
              t.mo = 1;
              t.y++;
            }
          }
        }
      }
    }
    this.encode();
  }

  /** structured time → BCD registers (preserves the CH bit in seconds + 12/24h selection off). */
  private encode(): void {
    const ch = this.rd(0) & 0x80;
    this.reg[0] = dec2bcd(this.t.s) | ch;
    this.reg[1] = dec2bcd(this.t.mi);
    this.reg[2] = dec2bcd(this.t.h); // 24-hour mode (bit6 = 0)
    this.reg[3] = this.t.dow & 0x07;
    this.reg[4] = dec2bcd(this.t.d);
    this.reg[5] = dec2bcd(this.t.mo);
    this.reg[6] = dec2bcd(this.t.y % 100);
  }

  /** BCD registers → structured time (honours a sketch-written 12-hour value). */
  private decode(): void {
    this.t.s = bcd2dec(this.rd(0) & 0x7f);
    this.t.mi = bcd2dec(this.rd(1) & 0x7f);
    const hr = this.rd(2);
    if (hr & 0x40) {
      // 12-hour mode: bit5 = PM, bits4..0 = hour (BCD 1..12)
      const h12 = bcd2dec(hr & 0x1f);
      const pm = (hr & 0x20) !== 0;
      this.t.h = (h12 % 12) + (pm ? 12 : 0);
    } else {
      this.t.h = bcd2dec(hr & 0x3f);
    }
    this.t.dow = this.rd(3) & 0x07 || 1;
    this.t.d = bcd2dec(this.rd(4) & 0x3f) || 1;
    this.t.mo = bcd2dec(this.rd(5) & 0x1f) || 1;
    this.t.y = 2000 + bcd2dec(this.rd(6));
  }

  /** Live inspector edit: nudge a start-time field on the running clock and re-encode. */
  applyField(name: string, value: number): boolean {
    this.decode();
    if (name === 'hour') this.t.h = ((Math.round(value) % 24) + 24) % 24;
    else if (name === 'minute') this.t.mi = ((Math.round(value) % 60) + 60) % 60;
    else return false;
    this.encode();
    return true;
  }

  /** "YYYY-MM-DD HH:MM:SS" for the inspector reflection. */
  get isoTime(): string {
    this.decode();
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const t = this.t;
    return `${t.y}-${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}`;
  }

  // ── I2cDevice ──
  startWrite(): boolean {
    this.firstWriteByte = true;
    return true;
  }
  startRead(): boolean {
    return true;
  }
  write(value: number): boolean {
    if (this.firstWriteByte) {
      this.ptr = value & 0x3f;
      this.firstWriteByte = false;
    } else {
      this.reg[this.ptr] = value & 0xff;
      this.ptr = (this.ptr + 1) & 0x3f;
      this.decode(); // keep structured time in step with sketch-written registers
    }
    return true;
  }
  read(): number {
    const v = this.rd(this.ptr);
    this.ptr = (this.ptr + 1) & 0x3f;
    return v;
  }
  stop(): void {
    /* the register pointer persists across transactions, like the real chip */
  }
}
