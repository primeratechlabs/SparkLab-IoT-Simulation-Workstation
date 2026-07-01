import { describe, it, expect } from 'vitest';
import { Ds1307 } from './ds1307.js';
import { MockCircuitHost } from './mock-host.js';

const bcd = (n: number): number => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;

/** Drive the I2C register protocol: point at `ptr`, then read `n` auto-incrementing bytes. */
function readRegs(d: Ds1307, ptr: number, n: number): number[] {
  d.startWrite();
  d.write(ptr);
  d.startRead();
  return Array.from({ length: n }, () => d.read());
}

describe('DS1307 RTC (I2C 0x68)', () => {
  it('registers as an I2C slave at 0x68', () => {
    const d = new Ds1307('rtc1');
    const host = new MockCircuitHost();
    d.attach(host);
    expect(host.i2c.get(0x68)).toBe(d);
  });

  it('encodes the constructor time into BCD time registers', () => {
    const d = new Ds1307('rtc1', { hour: 13, minute: 45 });
    const [sec, min, hour] = readRegs(d, 0x00, 3);
    expect((sec ?? 0) & 0x7f).toBe(bcd(0));
    expect(min).toBe(bcd(45));
    expect(hour).toBe(bcd(13));
  });

  it('round-trips a time the sketch writes (RTClib adjust → now)', () => {
    const d = new Ds1307('rtc1');
    // master write: pointer 0x00, then sec=30, min=20, hour=9 in BCD
    d.startWrite();
    d.write(0x00);
    d.write(bcd(30));
    d.write(bcd(20));
    d.write(bcd(9));
    expect(readRegs(d, 0x00, 3)).toEqual([bcd(30), bcd(20), bcd(9)]);
  });

  it('advances one second per virtual second while the clock runs', () => {
    const d = new Ds1307('rtc1', { hour: 0, minute: 0 });
    const host = new MockCircuitHost();
    d.attach(host);
    host.advance(3_000_000_000); // 3 s
    expect((readRegs(d, 0x00, 1)[0] ?? 0) & 0x7f).toBe(bcd(3));
  });

  it('carries seconds → minutes correctly', () => {
    const d = new Ds1307('rtc1');
    const host = new MockCircuitHost();
    d.attach(host);
    d.startWrite();
    d.write(0x00);
    d.write(bcd(59)); // second = 59
    host.advance(1_000_000_000);
    expect(readRegs(d, 0x00, 2)).toEqual([bcd(0), bcd(1)]); // 00s, 01m
  });

  it('halts when the clock-halt (CH) bit is set', () => {
    const d = new Ds1307('rtc1', { hour: 0, minute: 0 });
    const host = new MockCircuitHost();
    d.attach(host);
    d.startWrite();
    d.write(0x00);
    d.write(0x80); // CH=1, seconds=0
    host.advance(5_000_000_000);
    expect(readRegs(d, 0x00, 1)[0]).toBe(0x80); // still halted at 0
  });

  it('decodes 12-hour PM mode into the 24-hour iso string', () => {
    const d = new Ds1307('rtc1');
    d.startWrite();
    d.write(0x02); // hour register
    d.write(0x40 | 0x20 | bcd(3)); // 12h flag + PM + 3 → 15:00
    expect(d.isoTime).toContain('15:');
  });
});
