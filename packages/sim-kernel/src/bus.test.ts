import { describe, it, expect } from 'vitest';
import { I2cBus, spiModeToCpolCpha, type I2cDevice } from './bus.js';

/** Minimal echo/log slave for tests. */
function makeDevice(): I2cDevice & { written: number[]; readQueue: number[] } {
  return {
    written: [],
    readQueue: [],
    startWrite() {
      return true;
    },
    startRead() {
      return true;
    },
    write(b) {
      this.written.push(b);
      return true;
    },
    read() {
      return this.readQueue.shift() ?? 0xff;
    },
    stop() {},
  };
}

describe('I2cBus', () => {
  it('routes a write transaction to the addressed device with ACKs', () => {
    const bus = new I2cBus();
    bus.setPullups(true);
    const dev = makeDevice();
    bus.addDevice(0x27, dev);

    expect(bus.connect(0x27, false)).toBe(true); // addressed for write, ACK
    expect(bus.write(0x41)).toBe(true);
    expect(bus.write(0x42)).toBe(true);
    bus.stop();
    expect(dev.written).toEqual([0x41, 0x42]);
  });

  it('NACKs an address with no device', () => {
    const bus = new I2cBus();
    bus.setPullups(true);
    bus.addDevice(0x27, makeDevice());
    expect(bus.connect(0x3c, false)).toBe(false); // nobody home
    expect(bus.busWarnings.some((w) => w.type === 'no-ack')).toBe(true);
  });

  it('detects an address conflict (two devices, same address) for the ERC', () => {
    const bus = new I2cBus();
    bus.setPullups(true);
    bus.addDevice(0x27, makeDevice());
    bus.addDevice(0x27, makeDevice());
    expect(bus.conflictingAddresses()).toEqual([0x27]);
    expect(bus.connect(0x27, false)).toBe(false); // contention → no clean ACK
    expect(bus.busWarnings.some((w) => w.type === 'address-conflict')).toBe(true);
  });

  it('warns when the bus has no pull-ups', () => {
    const bus = new I2cBus();
    bus.addDevice(0x27, makeDevice());
    bus.connect(0x27, false);
    expect(bus.busWarnings.some((w) => w.type === 'missing-pullup')).toBe(true);
  });

  it('supports reads from a slave', () => {
    const bus = new I2cBus();
    bus.setPullups(true);
    const dev = makeDevice();
    dev.readQueue.push(0xde, 0xad);
    bus.addDevice(0x68, dev);
    expect(bus.connect(0x68, true)).toBe(true);
    expect(bus.read()).toBe(0xde);
    expect(bus.read()).toBe(0xad);
    bus.stop();
  });

  it('rejects out-of-range addresses', () => {
    const bus = new I2cBus();
    expect(() => bus.addDevice(0x80, makeDevice())).toThrow(/range/);
  });

  it('NACKs an address that was never registered (no stored list)', () => {
    const bus = new I2cBus();
    bus.setPullups(true);
    // No devices added at all → connect must NACK and not throw.
    expect(bus.connect(0x10, false)).toBe(false);
    expect(bus.busWarnings.some((w) => w.type === 'no-ack' && w.address === 0x10)).toBe(true);
  });
});

describe('spiModeToCpolCpha', () => {
  it('maps SPI modes 0–3 to (CPOL, CPHA)', () => {
    expect(spiModeToCpolCpha(0)).toEqual({ cpol: 0, cpha: 0 });
    expect(spiModeToCpolCpha(1)).toEqual({ cpol: 0, cpha: 1 });
    expect(spiModeToCpolCpha(2)).toEqual({ cpol: 1, cpha: 0 });
    expect(spiModeToCpolCpha(3)).toEqual({ cpol: 1, cpha: 1 });
  });
});
