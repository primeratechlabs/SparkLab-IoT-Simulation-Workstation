/**
 * Circuit — the Stage 3 integration that runs a complete breadboard through the
 * event-driven kernel. It wires the AVR emulator (the virtual-time master clock) to
 * the sim-kernel (VTK + I2C bus) and the component models, implementing the
 * CircuitHost they attach to. Everything advances on the emulator's cycle clock
 * (invariant I3), so a run produces the same result at any wall speed.
 *
 *   emulator (AVRRunner) ──gpio/adc/uart/twi──▶ CircuitHost ──▶ components
 *                        ◀──inputs (drivePin/setAdc/i2cReply)──┘
 */
import { AVRTWI, twiConfig, PinState, type TWIEventHandler } from 'avr8js';
import { AVRRunner, digitalPinToPort, UNO_CLOCK_HZ, type PortName } from '@sparklab/emulators';
import { VirtualTimeKernel, I2cBus } from '@sparklab/sim-kernel';
import type { CircuitHost, DriveLevel, SimComponent } from '@sparklab/components-core';

const PORTS: PortName[] = ['B', 'C', 'D'];

export interface CircuitOptions {
  frequencyHz?: number;
  i2cPullups?: boolean;
}

export class Circuit implements CircuitHost {
  readonly runner: AVRRunner;
  readonly bus = new I2cBus();
  private readonly vtk = new VirtualTimeKernel();
  private readonly twi: AVRTWI;
  private readonly components: SimComponent[] = [];
  private readonly tickers: SimComponent[] = [];
  private readonly watchers = new Map<number, ((level: 'low' | 'high') => void)[]>();
  private readonly lastLevel = new Map<number, 'low' | 'high'>();
  private serialOut = '';

  constructor(firmware: Uint8Array, opts: CircuitOptions = {}) {
    const freq = opts.frequencyHz ?? UNO_CLOCK_HZ;
    this.runner = new AVRRunner(firmware, freq);
    this.bus.setPullups(opts.i2cPullups ?? true);
    this.twi = new AVRTWI(this.runner.cpu, twiConfig, freq);
    this.twi.eventHandler = this.makeTwiHandler();
    this.runner.onSerialByte((b) => {
      this.serialOut += String.fromCharCode(b);
      if (this.serialOut.length > 8000) this.serialOut = this.serialOut.slice(-8000);
    });
    for (const port of PORTS) this.runner.addGpioListener(port, () => this.scanWatched(port));
  }

  /** Attach a component to the circuit (wires its pins via the host API). */
  add(component: SimComponent): this {
    component.attach(this);
    this.components.push(component);
    if (component.tick) this.tickers.push(component);
    return this;
  }

  get serial(): string {
    return this.serialOut;
  }

  /**
   * Run for up to `maxVirtualMs` of VIRTUAL time, optionally stopping early when
   * `stopWhen()` is true. Each instruction advances the master clock; the kernel
   * fires due component events and timing-critical sensors get a per-instruction tick.
   */
  run(maxVirtualMs: number, stopWhen?: () => boolean): void {
    const endNs = this.runner.virtualTimeNs + maxVirtualMs * 1e6;
    while (this.runner.virtualTimeNs < endNs) {
      // Apply due input events + sensor drives BEFORE the instruction so the pin the
      // instruction reads already reflects the component state at this virtual time.
      if (this.vtk.pending) this.vtk.runUntil(this.runner.virtualTimeNs);
      for (const c of this.tickers) c.tick!();
      this.runner.step();
      if (stopWhen && stopWhen()) return;
    }
  }

  // ── CircuitHost ─────────────────────────────────────────────────────────
  now(): number {
    return this.runner.virtualTimeNs;
  }
  schedule(delayNs: number, cb: () => void): number {
    return this.vtk.scheduleAt(this.runner.virtualTimeNs + delayNs, cb);
  }
  watchPin(pin: number, cb: (level: 'low' | 'high') => void): void {
    const list = this.watchers.get(pin) ?? [];
    list.push(cb);
    this.watchers.set(pin, list);
    const level = this.pinLevel(pin);
    this.lastLevel.set(pin, level);
    cb(level);
  }
  pinIsReleased(pin: number): boolean {
    const { port, index } = digitalPinToPort(pin);
    const s = this.runner.pinState(port, index);
    return s === PinState.Input || s === PinState.InputPullUp;
  }
  pinLevel(pin: number): 'low' | 'high' {
    const { port, index } = digitalPinToPort(pin);
    return this.runner.pinState(port, index) === PinState.Low ? 'low' : 'high';
  }
  drivePin(pin: number, level: DriveLevel): void {
    // 'high-z' = stop driving; with the MCU's pull-up that reads HIGH.
    this.runner.setDigitalInput(pin, level !== 'low');
  }
  setAdcVolts(channel: number, volts: number): void {
    this.runner.setAnalogVoltage(channel, volts);
  }
  addI2cDevice(address: number, device: import('@sparklab/sim-kernel').I2cDevice): void {
    this.bus.addDevice(address, device);
  }

  // ── internals ──
  private scanWatched(port: PortName): void {
    for (const [pin, cbs] of this.watchers) {
      if (digitalPinToPort(pin).port !== port) continue;
      const level = this.pinLevel(pin);
      if (level !== this.lastLevel.get(pin)) {
        this.lastLevel.set(pin, level);
        for (const cb of cbs) cb(level);
      }
    }
  }

  private makeTwiHandler(): TWIEventHandler {
    const bus = this.bus;
    const twi = (): AVRTWI => this.twi;
    return {
      start() {
        twi().completeStart();
      },
      stop() {
        bus.stop();
        twi().completeStop();
      },
      connectToSlave(addr: number, write: boolean) {
        twi().completeConnect(bus.connect(addr, !write)); // write=true → not a read
      },
      writeByte(value: number) {
        twi().completeWrite(bus.write(value));
      },
      readByte() {
        twi().completeRead(bus.read());
      },
    };
  }
}
