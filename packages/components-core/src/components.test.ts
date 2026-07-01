import { describe, it, expect } from 'vitest';
import type { I2cDevice, SpiDevice } from '@sparklab/sim-kernel';
import {
  Led,
  PushButton,
  Potentiometer,
  Dht22,
  HcSr04,
  LcdI2c,
  type CircuitHost,
  type DriveLevel,
} from './index.js';

/** In-memory CircuitHost for component unit tests. */
class MockHost implements CircuitHost {
  timeNs = 0;
  driven = new Map<number, DriveLevel>();
  adc = new Map<number, number>();
  i2c = new Map<number, I2cDevice>();
  private watchers = new Map<number, ((l: 'low' | 'high') => void)[]>();
  private mcuLevel = new Map<number, 'low' | 'high'>();
  private released = new Map<number, boolean>();
  private timers: { at: number; cb: () => void }[] = [];

  now(): number {
    return this.timeNs;
  }
  schedule(delayNs: number, cb: () => void): number {
    this.timers.push({ at: this.timeNs + delayNs, cb });
    return this.timers.length;
  }
  watchPin(pin: number, cb: (l: 'low' | 'high') => void): void {
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
  spiDevices: SpiDevice[] = [];
  addSpiDevice(device: SpiDevice): void {
    this.spiDevices.push(device);
  }

  // ── test helpers ──
  mcuWrite(pin: number, level: 'low' | 'high'): void {
    this.mcuLevel.set(pin, level);
    this.released.set(pin, false);
    for (const w of this.watchers.get(pin) ?? []) w(level);
  }
  mcuRelease(pin: number): void {
    this.released.set(pin, true);
  }
  advance(ns: number): void {
    const end = this.timeNs + ns;
    this.timers.sort((a, b) => a.at - b.at);
    while (this.timers.length && this.timers[0]!.at <= end) {
      const t = this.timers.shift()!;
      this.timeNs = t.at;
      t.cb();
    }
    this.timeNs = end;
  }
}

describe('Led', () => {
  it('lights when the pin is driven HIGH and counts toggles', () => {
    const host = new MockHost();
    const led = new Led('led1', 13);
    led.attach(host);
    expect(led.on).toBe(false);
    host.mcuWrite(13, 'high');
    expect(led.on).toBe(true);
    host.mcuWrite(13, 'low');
    expect(led.on).toBe(false);
    expect(led.toggles).toBe(2);
  });
});

describe('PushButton', () => {
  it('drives the pin LOW when pressed, releases (high-z) when not', () => {
    const host = new MockHost();
    const btn = new PushButton('btn', 2);
    btn.attach(host);
    expect(host.driven.get(2)).toBe('high-z');
    btn.press();
    expect(host.driven.get(2)).toBe('low');
    btn.release();
    expect(host.driven.get(2)).toBe('high-z');
  });
});

describe('Potentiometer', () => {
  it('sets the ADC voltage from the wiper position', () => {
    const host = new MockHost();
    const pot = new Potentiometer('pot', 0);
    pot.attach(host);
    pot.setPosition(0.5);
    expect(host.adc.get(0)).toBeCloseTo(2.5, 2);
    pot.setPosition(1);
    expect(host.adc.get(0)).toBeCloseTo(5, 2);
  });
});

describe('LcdI2c', () => {
  it('reconstructs printed characters from PCF8574 nibble writes', () => {
    const host = new MockHost();
    const lcd = new LcdI2c('lcd', 0x27);
    lcd.attach(host);
    const dev = host.i2c.get(0x27)!;
    // Write 'A' (0x41) as two RS=1 nibbles, each latched on an E falling edge.
    const sendNibble = (nibble: number, rs: number): void => {
      const base = (nibble << 4) | rs;
      dev.write(base | 0b100); // E high
      dev.write(base); // E low → latch
    };
    sendNibble(0x4, 1); // high nibble of 'A'
    sendNibble(0x1, 1); // low nibble
    expect(lcd.text).toBe('A');
    expect(lcd.bytes).toBe(4);
  });
});

describe('HcSr04', () => {
  it('emits an ECHO pulse whose width ≈ 58µs per cm after a trigger', () => {
    const host = new MockHost();
    const sonar = new HcSr04('sonar', 8, 9);
    sonar.distanceCm = 10; // → ~580µs echo
    sonar.attach(host);
    expect(host.driven.get(9)).toBe('low');

    host.mcuWrite(8, 'high'); // trigger rising edge
    host.advance(250_000); // sensor raises ECHO ~250µs later
    expect(host.driven.get(9)).toBe('high');
    host.advance(580_000); // echo width for 10cm
    expect(host.driven.get(9)).toBe('low');
    expect(sonar.pulses).toBe(1);
  });
});

describe('Dht22', () => {
  it('detects the MCU start pulse and drives the data line during its reply', () => {
    const host = new MockHost();
    const dht = new Dht22('dht', 7, { tempC: 24, humidity: 55 });
    dht.attach(host);

    // MCU start pulse: drive LOW, then release the line.
    host.mcuWrite(7, 'low');
    dht.tick();
    host.mcuRelease(7);
    dht.tick(); // sees low→release → schedules the reply
    expect(dht.triggers).toBe(1);

    // The reply is scheduled on the kernel; advancing time fires the driven segments.
    host.advance(100_000); // 100µs into the reply
    expect(['low', 'high']).toContain(host.driven.get(7));
    host.advance(5_000_000); // well past the end → line released
    expect(host.driven.get(7)).toBe('high-z');
  });
});
