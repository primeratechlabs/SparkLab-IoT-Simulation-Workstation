import type { I2cDevice } from '@sparklab/sim-kernel';
import type { CircuitHost, SimComponent } from './sdk.js';

const WHO_AM_I = 0x75;
const ACCEL_XOUT_H = 0x3b;
const ACCEL_LSB_PER_G = 16384; // ±2g full-scale (default AFS_SEL=0)
const GYRO_LSB_PER_DPS = 131; // ±250°/s full-scale (default FS_SEL=0)

const i16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

/**
 * MPU6050 6-axis IMU on I2C (address 0x68). It answers the register protocol the Adafruit_MPU6050 / raw
 * `Wire` drivers use: WHO_AM_I (0x75) returns 0x68, PWR_MGMT_1 (0x6B) is writable (wake), and the
 * acceleration (0x3B…) + temperature (0x41) + gyro (0x43…) registers are 16-bit big-endian two's-
 * complement values derived from the configured orientation. At rest the board reads +1g on Z (gravity);
 * tilt/shake is set live through the inspector so a sketch reads a real, changing vector.
 */
export class Mpu6050 implements SimComponent, I2cDevice {
  private readonly reg = new Uint8Array(128);
  private ptr = 0;
  // physical state the registers encode (g for accel, °/s for gyro, °C for temp).
  private ax = 0;
  private ay = 0;
  private az = 1; // gravity on Z at rest
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private tempC = 25;

  constructor(
    readonly id: string,
    private readonly address = 0x68,
  ) {
    this.reg[WHO_AM_I] = 0x68;
    this.refresh();
  }

  attach(host: CircuitHost): void {
    host.addI2cDevice(this.address, this);
  }

  setAccel(x: number, y: number, z: number): void {
    this.ax = x;
    this.ay = y;
    this.az = z;
  }
  setGyro(x: number, y: number, z: number): void {
    this.gx = x;
    this.gy = y;
    this.gz = z;
  }
  setTemp(c: number): void {
    this.tempC = c;
  }

  /** Live inspector edit: set one accel/gyro/temp field and recompute the registers. */
  applyField(name: string, value: number): boolean {
    switch (name) {
      case 'accelX':
        this.ax = value;
        break;
      case 'accelY':
        this.ay = value;
        break;
      case 'accelZ':
        this.az = value;
        break;
      case 'gyroX':
        this.gx = value;
        break;
      case 'gyroY':
        this.gy = value;
        break;
      case 'gyroZ':
        this.gz = value;
        break;
      case 'temp':
        this.tempC = value;
        break;
      default:
        return false;
    }
    this.refresh();
    return true;
  }

  /** Accel vector magnitude/text for the inspector reflection. */
  get accelText(): string {
    return `ax=${this.ax.toFixed(2)} ay=${this.ay.toFixed(2)} az=${this.az.toFixed(2)} g`;
  }

  private put16(addr: number, raw: number): void {
    const u = raw & 0xffff;
    this.reg[addr] = (u >> 8) & 0xff;
    this.reg[addr + 1] = u & 0xff;
  }

  /** Recompute the sensor registers from the physical state (MPU6050 scaling + temp formula). */
  private refresh(): void {
    this.put16(ACCEL_XOUT_H, i16(this.ax * ACCEL_LSB_PER_G));
    this.put16(ACCEL_XOUT_H + 2, i16(this.ay * ACCEL_LSB_PER_G));
    this.put16(ACCEL_XOUT_H + 4, i16(this.az * ACCEL_LSB_PER_G));
    this.put16(0x41, i16((this.tempC - 36.53) * 340)); // TEMP_OUT = (T-36.53)*340
    this.put16(0x43, i16(this.gx * GYRO_LSB_PER_DPS));
    this.put16(0x45, i16(this.gy * GYRO_LSB_PER_DPS));
    this.put16(0x47, i16(this.gz * GYRO_LSB_PER_DPS));
  }

  // ── I2cDevice ──
  startWrite(): boolean {
    this.firstWriteByte = true;
    return true;
  }
  startRead(): boolean {
    this.refresh(); // present a fresh sample for this read burst
    return true;
  }
  private firstWriteByte = true;
  write(value: number): boolean {
    if (this.firstWriteByte) {
      this.ptr = value & 0x7f;
      this.firstWriteByte = false;
    } else {
      this.reg[this.ptr] = value & 0xff; // config writes (PWR_MGMT, sample-rate, etc.) are accepted
      this.ptr = (this.ptr + 1) & 0x7f;
    }
    return true;
  }
  read(): number {
    const v = this.reg[this.ptr] ?? 0;
    this.ptr = (this.ptr + 1) & 0x7f;
    return v;
  }
  stop(): void {}
}
