/**
 * avr8js glue for ATmega328P (Arduino Uno) — REFERENCE-SPEC Stage 2.
 *
 * Wraps avr8js CPU + GPIO ports + timers + USART + ADC into a single runner with
 * virtual-time semantics (invariant I3): time is derived from cpu.cycles / clock
 * frequency, NOT wall-clock, so throttling or fast-forwarding never changes the
 * simulated timing relationships.
 */

import {
  CPU,
  avrInstruction,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  AVRADC,
  AVRWatchdog,
  AVRClock,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  adcConfig,
  watchdogConfig,
  PinState,
} from 'avr8js';

export const UNO_CLOCK_HZ = 16_000_000;
const FLASH_SIZE = 0x8000; // 32 KB

export type PortName = 'B' | 'C' | 'D';

/** Arduino Uno digital pin → AVR port/bit. D0–7=PORTD, D8–13=PORTB. */
export function digitalPinToPort(pin: number): { port: PortName; index: number } {
  if (pin >= 0 && pin <= 7) return { port: 'D', index: pin };
  if (pin >= 8 && pin <= 13) return { port: 'B', index: pin - 8 };
  throw new Error(`unsupported digital pin: ${pin}`);
}

/** Arduino Uno analog pin A0–A5 → ADC channel 0–5 (also PORTC bits 0–5). */
export function analogPinToChannel(pin: number): number {
  if (pin >= 0 && pin <= 5) return pin;
  throw new Error(`unsupported analog pin: A${pin}`);
}

export type GpioListener = (value: number, oldValue: number) => void;

export class AVRRunner {
  readonly cpu: CPU;
  readonly portB: AVRIOPort;
  readonly portC: AVRIOPort;
  readonly portD: AVRIOPort;
  readonly usart: AVRUSART;
  readonly adc: AVRADC;
  readonly timer0: AVRTimer;
  readonly timer1: AVRTimer;
  readonly timer2: AVRTimer;
  /** Watchdog timer — Arduino_FreeRTOS uses its interrupt (WDT_vect) as the RTOS tick source. */
  readonly watchdog: AVRWatchdog;
  readonly frequencyHz: number;

  constructor(programBytes: Uint8Array, frequencyHz = UNO_CLOCK_HZ) {
    if (programBytes.length > FLASH_SIZE) {
      throw new Error(
        `firmware too large: ${programBytes.length} bytes > ${FLASH_SIZE} (ATmega328P flash)`,
      );
    }
    const flash = new Uint8Array(FLASH_SIZE);
    flash.set(programBytes);
    this.cpu = new CPU(new Uint16Array(flash.buffer));
    this.frequencyHz = frequencyHz;

    this.portB = new AVRIOPort(this.cpu, portBConfig);
    this.portC = new AVRIOPort(this.cpu, portCConfig);
    this.portD = new AVRIOPort(this.cpu, portDConfig);
    this.timer0 = new AVRTimer(this.cpu, timer0Config);
    this.timer1 = new AVRTimer(this.cpu, timer1Config);
    this.timer2 = new AVRTimer(this.cpu, timer2Config);
    this.usart = new AVRUSART(this.cpu, usart0Config, frequencyHz);
    this.adc = new AVRADC(this.cpu, adcConfig);
    // The WDT self-wires into the CPU (write hooks + clock events); firing its interrupt drives the
    // Arduino_FreeRTOS scheduler tick. It needs the system clock to scale the 128 kHz WDT base against.
    this.watchdog = new AVRWatchdog(this.cpu, watchdogConfig, new AVRClock(this.cpu, frequencyHz));
  }

  private portByName(name: PortName): AVRIOPort {
    return name === 'B' ? this.portB : name === 'C' ? this.portC : this.portD;
  }

  /** Execute exactly one instruction (for fine-grained co-simulation with models). */
  step(): void {
    avrInstruction(this.cpu);
    this.cpu.tick();
  }

  /** Raw pin state (Low/High/Input/InputPullUp) — peripheral models inspect direction. */
  pinState(port: PortName, index: number): PinState {
    return this.portByName(port).pinState(index);
  }

  /** Virtual time in nanoseconds, derived from the cycle counter (I3). */
  get virtualTimeNs(): number {
    return Math.round((this.cpu.cycles / this.frequencyHz) * 1e9);
  }

  addGpioListener(port: PortName, listener: GpioListener): void {
    this.portByName(port).addListener(listener);
  }

  /** Read the logical state of a digital pin (true = High). */
  digitalRead(pin: number): boolean {
    const { port, index } = digitalPinToPort(pin);
    return this.portByName(port).pinState(index) === PinState.High;
  }

  /** Drive an input pin (e.g. a button) — BridgeInput gpio_input. */
  setDigitalInput(pin: number, value: boolean): void {
    const { port, index } = digitalPinToPort(pin);
    this.portByName(port).setPin(index, value);
  }

  /** Set an analog input voltage (0..5V) on an ADC channel — BridgeInput adc_value. */
  setAnalogVoltage(channel: number, volts: number): void {
    // ATmega328P has 8 ADC channels (0–7); A0–A5 are the Uno's exposed analog pins.
    if (!Number.isInteger(channel) || channel < 0 || channel > 7) {
      throw new Error(`ADC channel out of range: ${channel}`);
    }
    // NaN/Infinity slip through Math.max/min unchanged and would corrupt the ADC;
    // reject them up front so the channel always holds a finite 0..5V level.
    if (!Number.isFinite(volts)) {
      throw new Error(`analog voltage must be finite: ${volts}`);
    }
    this.adc.channelValues[channel] = Math.max(0, Math.min(5, volts));
  }

  onSerialByte(listener: (byte: number) => void): void {
    this.usart.onByteTransmit = listener;
  }

  /** Feed a byte into the USART receiver (BridgeInput uart_rx). */
  serialWrite(byte: number): void {
    this.usart.writeByte(byte);
  }

  /**
   * Advance the CPU by approximately `cycles` clock cycles. Returns the actual
   * number of cycles executed. Pure virtual-time stepping (no wall-clock).
   */
  execute(cycles: number): number {
    const start = this.cpu.cycles;
    const target = start + cycles;
    // Safety cap: every instruction advances cpu.cycles by >=1, so the instruction
    // count can never exceed the requested cycles. A larger bound means the CPU
    // stopped advancing (stuck) — fail fast instead of hanging the worker.
    const maxInstructions = cycles + 1024;
    let executed = 0;
    while (this.cpu.cycles < target) {
      avrInstruction(this.cpu);
      this.cpu.tick();
      if (++executed > maxInstructions) {
        throw new Error('emulator stalled: cycle counter not advancing');
      }
    }
    return this.cpu.cycles - start;
  }

  /** Convenience: run for a virtual-time duration in milliseconds. */
  executeForMillis(ms: number): void {
    this.execute(Math.round((ms / 1000) * this.frequencyHz));
  }
}
