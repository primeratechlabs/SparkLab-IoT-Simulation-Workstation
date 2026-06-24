/**
 * ESP32-C3 SoC peripheral models (MMIO) for the firmware-backed simulation. These map onto
 * the Rv32Cpu's address space (doctrine: API → HAL → MMIO — the bottom layer). Start with the
 * GPIO + UART blocks a Blink/Serial sketch actually touches; more blocks (timers, LEDC, I2C)
 * layer on the same way. Register addresses are from the ESP32-C3 TRM.
 */
import type { Rv32Bus } from './rv32.js';

export const C3_UART0_BASE = 0x60000000; // ESP32-C3 UART0
export const C3_GPIO_BASE = 0x60004000;
export const C3_I2C0_BASE = 0x60013000; // ESP32-C3 I2C0
export const C3_LEDC_BASE = 0x60019000; // sim LEDC (PWM)
/** Sim-only MMIO window the Arduino sim-runtime reads for millis()/micros() (§22 profile). */
export const C3_SYSTIMER_BASE = 0x60010000;
export const C3_ADC_BASE = 0x60020000; // sim ADC (analogRead per channel)
const GPIO_OUT_REG = 0x04; // output value
const GPIO_OUT_W1TS_REG = 0x08; // write-1-to-set
const GPIO_OUT_W1TC_REG = 0x0c; // write-1-to-clear
const GPIO_ENABLE_REG = 0x20; // output-enable value
const GPIO_ENABLE_W1TS_REG = 0x24;
const GPIO_ENABLE_W1TC_REG = 0x28;
const GPIO_IN_REG = 0x3c; // input value (digitalRead)

/**
 * GPIO output block. Tracks the 32-bit output + enable registers and counts edges so a sim
 * host can observe pin transitions (e.g. an LED blinking) without polling. Pins 0..31.
 */
export class C3Gpio implements Partial<Rv32Bus> {
  out = 0; // GPIO_OUT
  enable = 0; // GPIO_ENABLE
  in = 0; // GPIO_IN (driven by external sources — buttons, sensors)
  /** rising/falling edge counts per pin, for sim assertions / waveform. */
  readonly edges = new Int32Array(32);
  /** optional hook fired on any output change: (pin, level). */
  onChange?: (pin: number, level: 0 | 1) => void;

  private apply(next: number): void {
    const changed = (this.out ^ next) >>> 0;
    if (changed) {
      for (let pin = 0; pin < 32; pin++) {
        const bit = 1 << pin;
        if (changed & bit) {
          const level: 0 | 1 = next & bit ? 1 : 0;
          this.edges[pin]!++;
          this.onChange?.(pin, level);
        }
      }
    }
    this.out = next >>> 0;
  }

  /** Current level of one pin (output register bit). */
  level(pin: number): 0 | 1 {
    return (this.out >>> pin) & 1 ? 1 : 0;
  }

  /** Drive an input pin (e.g. a button or sensor); digitalRead(pin) reads it back. */
  setInput(pin: number, level: 0 | 1): void {
    this.in = level ? (this.in | (1 << pin)) >>> 0 : (this.in & ~(1 << pin)) >>> 0;
  }

  read32(addr: number): number {
    switch (addr - C3_GPIO_BASE) {
      case GPIO_OUT_REG:
        return this.out >>> 0;
      case GPIO_ENABLE_REG:
        return this.enable >>> 0;
      case GPIO_IN_REG:
        return this.in >>> 0;
      default:
        return 0;
    }
  }
  write32(addr: number, v: number): void {
    const off = addr - C3_GPIO_BASE;
    switch (off) {
      case GPIO_OUT_REG:
        this.apply(v >>> 0);
        return;
      case GPIO_OUT_W1TS_REG:
        this.apply((this.out | v) >>> 0);
        return;
      case GPIO_OUT_W1TC_REG:
        this.apply((this.out & ~v) >>> 0);
        return;
      case GPIO_ENABLE_REG:
        this.enable = v >>> 0;
        return;
      case GPIO_ENABLE_W1TS_REG:
        this.enable = (this.enable | v) >>> 0;
        return;
      case GPIO_ENABLE_W1TC_REG:
        this.enable = (this.enable & ~v) >>> 0;
        return;
    }
  }
  // byte/halfword access fall back to 32-bit register granularity
  read8(addr: number): number {
    return (this.read32(addr & ~3) >>> ((addr & 3) * 8)) & 0xff;
  }
  read16(addr: number): number {
    return (this.read32(addr & ~3) >>> ((addr & 2) * 8)) & 0xffff;
  }
}

/**
 * UART0 TX capture. The sim-runtime's Serial.write() stores bytes to the UART FIFO register
 * (offset 0); this collects them into a string a sim host can read back as the serial console
 * — the Serial half of the Stage-4 gate. RX is not modelled yet (no host→device input here).
 */
export class C3Uart implements Partial<Rv32Bus> {
  private readonly out: number[] = [];
  /** fired per transmitted byte (e.g. to stream the console live). */
  onByte?: (b: number) => void;

  /** Everything written to TX so far, decoded as Latin-1/UTF-8-ish text. */
  text(): string {
    return String.fromCharCode(...this.out);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }

  private tx(b: number): void {
    this.out.push(b & 0xff);
    this.onByte?.(b & 0xff);
  }
  write32(addr: number, v: number): void {
    if (addr - C3_UART0_BASE === 0) this.tx(v); // UART_FIFO_REG
  }
  write8(addr: number, v: number): void {
    if (addr - C3_UART0_BASE === 0) this.tx(v);
  }
  write16(addr: number, v: number): void {
    if (addr - C3_UART0_BASE === 0) this.tx(v);
  }
  // status reads: report TX always ready, RX empty
  read32(): number {
    return 0xffff; // tx_fifo_cnt slots free, etc. — non-zero so the runtime never blocks
  }
  read8(): number {
    return 0xff;
  }
  read16(): number {
    return 0xffff;
  }
}

/**
 * Virtual-time clock the Arduino sim-runtime reads for millis()/micros(). Time is derived
 * from a cycle source (the CPU's retired-instruction counter), NOT wall-clock — so delay()
 * busy-loops advance virtual time and terminate deterministically, independent of host speed
 * (invariant I3). `cyclesPerMs` maps emulated cycles → milliseconds (160k ≈ a 160 MHz C3;
 * tests use a smaller value so blink delays cost few cycles).
 */
export class C3SysTimer implements Partial<Rv32Bus> {
  constructor(
    private readonly now: () => number,
    public cyclesPerMs = 160_000,
  ) {}

  millis(): number {
    return Math.floor(this.now() / this.cyclesPerMs) >>> 0;
  }
  micros(): number {
    return Math.floor((this.now() * 1000) / this.cyclesPerMs) >>> 0;
  }

  read32(addr: number): number {
    switch (addr - C3_SYSTIMER_BASE) {
      case 0:
        return this.millis();
      case 4:
        return this.micros();
      default:
        return 0;
    }
  }
  read8(addr: number): number {
    return (this.read32(addr & ~3) >>> ((addr & 3) * 8)) & 0xff;
  }
  read16(addr: number): number {
    return (this.read32(addr & ~3) >>> ((addr & 2) * 8)) & 0xffff;
  }
}

/**
 * Sim ADC — analogRead(channel) reads the per-channel value register here. A host/sensor
 * model writes channel values (0..4095) via `set()`; the firmware reads them as analog inputs
 * (potentiometer, LDR, NTC, ...).
 */
export class C3Adc implements Partial<Rv32Bus> {
  private readonly values = new Int32Array(40);
  /** set the analog reading on a channel (0..4095 for the 12-bit ESP32 ADC). */
  set(channel: number, value: number): void {
    this.values[channel & 0x3f] = Math.max(0, Math.min(4095, value | 0));
  }
  read32(addr: number): number {
    return this.values[((addr - C3_ADC_BASE) >>> 2) & 0x3f]! >>> 0;
  }
  read8(addr: number): number {
    return (this.read32(addr & ~3) >>> ((addr & 3) * 8)) & 0xff;
  }
  read16(addr: number): number {
    return (this.read32(addr & ~3) >>> ((addr & 2) * 8)) & 0xffff;
  }
}

/**
 * Sim LEDC (PWM). The runtime's ledcSetup/ledcAttachPin/ledcWrite map onto these registers;
 * a sim host reads back the per-channel duty (e.g. an LED brightness or a servo angle).
 */
export class C3Ledc implements Partial<Rv32Bus> {
  readonly duty = new Int32Array(16);
  readonly config = new Int32Array(16);
  /** fired when a channel's duty changes. */
  onDuty?: (channel: number, duty: number) => void;

  write32(addr: number, v: number): void {
    const off = addr - C3_LEDC_BASE;
    const ch = (off >>> 3) & 0xf;
    if ((off & 0x4) === 0) {
      this.duty[ch] = v | 0;
      this.onDuty?.(ch, v >>> 0);
    } else {
      this.config[ch] = v | 0;
    }
  }
  write8(addr: number, v: number): void {
    this.write32(addr & ~3, v);
  }
  write16(addr: number, v: number): void {
    this.write32(addr & ~3, v);
  }
  read32(addr: number): number {
    const off = addr - C3_LEDC_BASE;
    const ch = (off >>> 3) & 0xf;
    return ((off & 0x4) === 0 ? this.duty[ch]! : this.config[ch]!) >>> 0;
  }
  read8(): number {
    return 0;
  }
  read16(): number {
    return 0;
  }
}

/** A slave on the I2C bus — the subset the sim-runtime's Wire shim drives (structural; the
 *  sim-kernel I2cDevice / components-core LcdI2c satisfy it). */
export interface I2cSlave {
  startWrite(): boolean;
  write(byte: number): boolean;
  stop(): void;
  /** master read transaction (optional — sensors implement this). */
  startRead?(): boolean;
  read?(): number;
}

/**
 * I2C0 master controller (sim). The runtime's Wire shim writes ADDR -> DATA... -> STOP to
 * these registers; the controller routes the byte stream to the addressed 7-bit slave (e.g.
 * a PCF8574 LCD backpack). Modelled at the transaction level — the API->HAL bridge for I2C
 * (full SCL/SDA bit-banging MMIO is a later layer).
 */
export class C3I2c implements Partial<Rv32Bus> {
  private readonly devices = new Map<number, I2cSlave>();
  private current: I2cSlave | null = null;
  private rxFifo: number[] = [];

  /** Attach a slave at a 7-bit address (e.g. 0x27 for a typical PCF8574 LCD backpack). */
  attach(address: number, dev: I2cSlave): void {
    this.devices.set(address & 0x7f, dev);
  }

  write32(addr: number, v: number): void {
    switch (addr - C3_I2C0_BASE) {
      case 0x04: // ADDR — begin a write transaction
        this.current = this.devices.get(v & 0x7f) ?? null;
        this.current?.startWrite();
        return;
      case 0x00: // DATA — one byte to the current slave
        this.current?.write(v & 0xff);
        return;
      case 0x08: // CMD — STOP
        this.current?.stop();
        this.current = null;
        return;
      case 0x0c: {
        // RADDR — requestFrom: read transaction. low7=addr, high bits=count
        const dev = this.devices.get(v & 0x7f) ?? null;
        const count = (v >>> 8) & 0xff;
        this.rxFifo = [];
        if (dev?.startRead?.()) {
          for (let i = 0; i < count; i++) this.rxFifo.push((dev.read?.() ?? 0xff) & 0xff);
        }
        return;
      }
    }
  }
  write8(addr: number, v: number): void {
    this.write32(addr, v);
  }
  write16(addr: number, v: number): void {
    this.write32(addr, v);
  }
  read32(addr: number): number {
    switch (addr - C3_I2C0_BASE) {
      case 0x10: // RDATA — pop one received byte
        return (this.rxFifo.shift() ?? 0xff) >>> 0;
      case 0x14: // RAVAIL — bytes left in the rx fifo
        return this.rxFifo.length >>> 0;
      default:
        return 0;
    }
  }
  read8(addr: number): number {
    return this.read32(addr & ~3) & 0xff;
  }
  read16(addr: number): number {
    return this.read32(addr & ~3) & 0xffff;
  }
}
