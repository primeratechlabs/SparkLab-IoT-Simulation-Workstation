/**
 * SocHost — the ESP32 (RISC-V / Xtensa) analog of `Circuit`'s AVR `CircuitHost`. It implements the
 * SAME backend-agnostic `CircuitHost` interface over an ESP32 SoC runner's public peripherals
 * (C3Gpio/C3Adc/C3I2c/C3Ledc), so ONE device model (`@sparklab/components-core`) attaches and runs
 * identically on Uno (Circuit) and the ESP32 SoCs (SocHost) — Uno/C3/Xtensa parity (invariant).
 *
 * Unlike Circuit (which owns its AVRRunner + run loop), the SoC runner is owned by the sim worker;
 * SocHost just binds to it. The worker calls `pump()` BEFORE each instruction (via the runner's
 * `beforeStep` hook) to fire due scheduled events + per-instruction sensor ticks — the same
 * "apply inputs before the instruction reads the pin" ordering Circuit uses (invariant I3).
 *
 * NOTE on fidelity: the SoC sim clock is coarse (≈20µs/cycle) vs AVR's 62.5ns, so sub-µs 1-wire/echo
 * timing (DHT/HC-SR04) is AVR-grade only; transaction/level devices (LED reflect, I²C LCD/OLED, ADC
 * sensors, digital input, PWM duty) are full fidelity on the SoC. Every device still ATTACHES on all
 * backends (the conformance lock requires it).
 */
import type { CircuitHost, DriveLevel, SimComponent } from '@sparklab/components-core';
import type { I2cDevice } from '@sparklab/sim-kernel';

/** The SoC runner peripherals SocHost binds to (Rv32Runner / XtensaRunner expose these publicly). */
export interface SocBackend {
  readonly gpio: {
    onChange?: (pin: number, level: 0 | 1) => void;
    level(pin: number): 0 | 1;
    enable: number;
    setInput(pin: number, level: 0 | 1): void;
  };
  readonly adc: { set(channel: number, value: number): void };
  readonly i2c: { attach(address: number, dev: I2cDevice): void };
  readonly ledc?: { onDuty?: (channel: number, duty: number) => void };
  /** current virtual time, ns (cycle-derived; invariant I3). */
  readonly virtualTimeNs: number;
}

const ADC_VREF = 3.3; // ESP32 ADC reference (sim): volts → 12-bit raw
const ADC_MAX = 4095;

export class SocHost implements CircuitHost {
  private readonly watchers = new Map<number, ((level: 'low' | 'high') => void)[]>();
  private readonly lastLevel = new Map<number, 'low' | 'high'>();
  private timers: { at: number; cb: () => void; id: number }[] = [];
  private readonly tickers: SimComponent[] = [];
  private nextTimerId = 1;
  /** per-channel PWM duty as a 0..1 fraction the firmware wrote via ledcWrite (UI brightness, CMB-04). */
  readonly duty = new Map<number, number>();

  constructor(
    private readonly soc: SocBackend,
    private readonly dutyResolutionMax = 255,
  ) {
    // Chain the runner's existing onChange (which keeps its `pins` snapshot) — don't replace it.
    const prev = soc.gpio.onChange;
    soc.gpio.onChange = (pin, level) => {
      prev?.(pin, level);
      const list = this.watchers.get(pin);
      if (!list) return;
      const lv: 'low' | 'high' = level ? 'high' : 'low';
      if (this.lastLevel.get(pin) === lv) return;
      this.lastLevel.set(pin, lv);
      for (const cb of list) cb(lv);
    };
    if (soc.ledc) {
      const prevDuty = soc.ledc.onDuty;
      soc.ledc.onDuty = (channel, d) => {
        prevDuty?.(channel, d);
        this.duty.set(channel, Math.max(0, Math.min(1, d / this.dutyResolutionMax)));
      };
    }
  }

  /** Attach a device to this host; its `tick()` (if any) runs each pre-step. */
  add(c: SimComponent): void {
    c.attach(this);
    if (c.tick) this.tickers.push(c);
  }

  /** Fire due scheduled events + per-instruction sensor ticks. Call BEFORE each cpu.step(). */
  pump(): void {
    const now = this.soc.virtualTimeNs;
    if (this.timers.length) {
      this.timers.sort((a, b) => a.at - b.at);
      while (this.timers.length && this.timers[0]!.at <= now) this.timers.shift()!.cb();
    }
    for (const c of this.tickers) c.tick!();
  }

  // ── CircuitHost ─────────────────────────────────────────────────────────
  now(): number {
    return this.soc.virtualTimeNs;
  }
  schedule(delayNs: number, cb: () => void): number {
    const id = this.nextTimerId++;
    this.timers.push({ at: this.soc.virtualTimeNs + delayNs, cb, id });
    return id;
  }
  watchPin(pin: number, cb: (level: 'low' | 'high') => void): void {
    const list = this.watchers.get(pin) ?? [];
    list.push(cb);
    this.watchers.set(pin, list);
    const lv = this.pinLevel(pin);
    this.lastLevel.set(pin, lv);
    cb(lv);
  }
  pinIsReleased(pin: number): boolean {
    return ((this.soc.gpio.enable >>> pin) & 1) === 0; // not output-enabled → input/released
  }
  pinLevel(pin: number): 'low' | 'high' {
    return this.soc.gpio.level(pin) ? 'high' : 'low';
  }
  drivePin(pin: number, level: DriveLevel): void {
    this.soc.gpio.setInput(pin, level === 'low' ? 0 : 1); // 'high' & 'high-z' (pull-up) read HIGH
  }
  setAdcVolts(channel: number, volts: number): void {
    this.soc.adc.set(channel, Math.round((volts / ADC_VREF) * ADC_MAX));
  }
  addI2cDevice(address: number, device: I2cDevice): void {
    this.soc.i2c.attach(address, device);
  }
}
