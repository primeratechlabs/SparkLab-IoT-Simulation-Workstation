/**
 * MockCircuitHost — an in-memory CircuitHost for component unit tests. It models the
 * MCU pin state the component reads (mcuWrite/mcuRelease), captures what the component
 * drives/sets, and fires scheduled callbacks when virtual time is advanced. Lets every
 * component be tested deterministically without the emulator.
 */
import type { I2cDevice, SpiDevice } from '@sparklab/sim-kernel';
import { SpiBus } from '@sparklab/sim-kernel';
import type { CircuitHost, DriveLevel } from './sdk.js';

export class MockCircuitHost implements CircuitHost {
  timeNs = 0;
  /** Last level the component drove onto each pin. */
  readonly driven = new Map<number, DriveLevel>();
  /** Last ADC voltage the component set per channel. */
  readonly adc = new Map<number, number>();
  /** I2C devices the component registered, keyed by address. */
  readonly i2c = new Map<number, I2cDevice>();
  /** SPI bus the component registered on (route bytes with `spiTransfer`). */
  readonly spi = new SpiBus();

  private readonly watchers = new Map<number, ((level: 'low' | 'high') => void)[]>();
  private readonly mcuLevel = new Map<number, 'low' | 'high'>();
  private readonly released = new Map<number, boolean>();
  private timers: { at: number; cb: () => void }[] = [];

  now(): number {
    return this.timeNs;
  }
  schedule(delayNs: number, cb: () => void): number {
    this.timers.push({ at: this.timeNs + delayNs, cb });
    return this.timers.length;
  }
  watchPin(pin: number, cb: (level: 'low' | 'high') => void): void {
    const list = this.watchers.get(pin) ?? [];
    list.push(cb);
    this.watchers.set(pin, list);
  }
  pinIsReleased(pin: number): boolean {
    return this.released.get(pin) ?? false;
  }
  pinLevel(pin: number): 'low' | 'high' {
    return this.mcuLevel.get(pin) ?? 'low';
  }
  drivePin(pin: number, level: DriveLevel): void {
    this.driven.set(pin, level);
  }
  setAdcVolts(channel: number, volts: number): void {
    this.adc.set(channel, volts);
  }
  addI2cDevice(address: number, device: I2cDevice): void {
    this.i2c.set(address, device);
  }
  addSpiDevice(device: SpiDevice): void {
    this.spi.addDevice(device);
  }

  // ── test helper ──
  /** Shift one byte to the CS-selected SPI slave; returns its MISO byte (0xff if none selected). */
  spiTransfer(mosi: number): number {
    return this.spi.transfer(mosi);
  }

  // ── test helpers ──
  /** Simulate the MCU driving a pin as an output (fires the component's watchers). */
  mcuWrite(pin: number, level: 'low' | 'high'): void {
    this.mcuLevel.set(pin, level);
    this.released.set(pin, false);
    for (const w of this.watchers.get(pin) ?? []) w(level);
  }
  /** Simulate the MCU releasing a pin (configuring it as input / high-z). */
  mcuRelease(pin: number): void {
    this.released.set(pin, true);
  }
  /** Advance virtual time by `ns`, firing every scheduled callback that comes due. */
  advance(ns: number): void {
    const end = this.timeNs + ns;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.timeNs = next.at;
      next.cb();
    }
    this.timeNs = end;
  }
}
