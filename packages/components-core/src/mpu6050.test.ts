import { describe, it, expect } from 'vitest';
import { Mpu6050 } from './mpu6050.js';
import { MockCircuitHost } from './mock-host.js';

/** Point at `ptr`, then read `n` auto-incrementing bytes. */
function readRegs(d: Mpu6050, ptr: number, n: number): number[] {
  d.startWrite();
  d.write(ptr);
  d.startRead();
  return Array.from({ length: n }, () => d.read());
}
const i16be = (hi = 0, lo = 0): number => {
  const u = (hi << 8) | lo;
  return u >= 0x8000 ? u - 0x10000 : u;
};

describe('MPU6050 IMU (I2C 0x68)', () => {
  it('registers as an I2C slave at 0x68', () => {
    const d = new Mpu6050('imu1');
    const host = new MockCircuitHost();
    d.attach(host);
    expect(host.i2c.get(0x68)).toBe(d);
  });

  it('answers WHO_AM_I (0x75) with 0x68', () => {
    const d = new Mpu6050('imu1');
    expect(readRegs(d, 0x75, 1)).toEqual([0x68]);
  });

  it('reads +1g on Z at rest (16384 LSB at ±2g)', () => {
    const d = new Mpu6050('imu1');
    const [xh, xl, yh, yl, zh, zl] = readRegs(d, 0x3b, 6);
    expect(i16be(xh, xl)).toBe(0);
    expect(i16be(yh, yl)).toBe(0);
    expect(i16be(zh, zl)).toBe(16384);
  });

  it('encodes a tilted/negative acceleration as two’s-complement', () => {
    const d = new Mpu6050('imu1');
    d.setAccel(1, 0, -1);
    const [xh, xl, , , zh, zl] = readRegs(d, 0x3b, 6);
    expect(i16be(xh, xl)).toBe(16384);
    expect(i16be(zh, zl)).toBe(-16384);
  });

  it('encodes gyro at 131 LSB per °/s', () => {
    const d = new Mpu6050('imu1');
    d.setGyro(0, 0, 250); // full-scale
    const [, , , , zh, zl] = readRegs(d, 0x43, 6);
    expect(i16be(zh, zl)).toBe(250 * 131);
  });

  it('applies a live inspector edit to one axis', () => {
    const d = new Mpu6050('imu1');
    expect(d.applyField('accelX', 0.5)).toBe(true);
    expect(d.applyField('nonsense', 1)).toBe(false);
    const [xh, xl] = readRegs(d, 0x3b, 2);
    expect(i16be(xh, xl)).toBe(Math.round(0.5 * 16384));
  });

  it('encodes temperature with the datasheet formula', () => {
    const d = new Mpu6050('imu1');
    d.setTemp(36.53); // → raw 0
    const [h, l] = readRegs(d, 0x41, 2);
    expect(i16be(h, l)).toBe(0);
  });

  it('accepts config writes (PWR_MGMT_1 wake) without breaking reads', () => {
    const d = new Mpu6050('imu1');
    d.startWrite();
    d.write(0x6b); // PWR_MGMT_1
    d.write(0x00); // wake
    expect(readRegs(d, 0x75, 1)).toEqual([0x68]);
  });
});
