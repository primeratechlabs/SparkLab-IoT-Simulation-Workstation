/**
 * Rv32Runner — the ESP32-C3 analog of AVRRunner: it bundles the rv32imc CPU, RAM bus, and the C3 SoC
 * peripherals (GPIO/UART/SysTimer/I2C/ADC) behind the SAME surface the sim worker uses for AVR —
 * `executeForMillis(ms)` + `virtualTimeNs` + GPIO/serial taps + input setters — so the worker can
 * branch on board with a symmetric seam. Runs the sim-build-profile firmware ELF (`-Ttext=0`).
 */
import {
  Rv32Cpu,
  SimpleBus,
  Rv32Trap,
  CAUSE_ILLEGAL,
  CAUSE_ECALL_M,
  CAUSE_BREAKPOINT,
} from './rv32.js';
import {
  C3Gpio,
  C3Uart,
  C3SysTimer,
  C3I2c,
  C3Adc,
  C3Ledc,
  C3_GPIO_BASE,
  C3_UART0_BASE,
  C3_SYSTIMER_BASE,
  C3_I2C0_BASE,
  C3_ADC_BASE,
  C3_LEDC_BASE,
} from './esp32c3-soc.js';
import { C3Net, C3_NET_BASE, type SocNetworkOpts } from './net-sim.js';
import { elfLoad } from './elf-load.js';

const RAM_SIZE = 0x100000; // 1 MiB — room for a libc/libstdc++-linked firmware + its malloc heap + stack
const STACK_TOP = 0xf0000; // stack grows down from 960 KiB; the sbrk heap grows up from the firmware .bss
// 1 cycle = 1 µs (1 MHz model) — instruction latency small vs the µs timings a sketch measures (pulseIn /
// HC-SR04 / DHT echo windows, delayMicroseconds). At the old 50 (20µs/instruction) the ~18 instructions
// between a TRIG pulse and pulseIn cost ~360µs, overshooting the ~250µs echo-start so pulseIn read 0.
// Throughput-safe: the worker throttles to wall-clock, so finer = more instructions per tick (within the
// step budget), same virtual-time-per-real-time. Mirrors xtensa-runner. See esp32-hcsr04 timing tests.
const DEFAULT_CYCLES_PER_MS = 1000;
const MAX_STEPS_PER_MS = 200_000; // guard against firmware spinning forever (bounded run per tick)

/** Plain-language halt cause for the worker/UI. Separates a simulator limitation (an instruction the
 *  interpreter doesn't implement) from the firmware intentionally aborting/exiting — both stop the run,
 *  but only the former means "not your bug, the sim can't run this yet". */
function rv32HaltReason(t: Rv32Trap): string {
  const pc = `0x${(t.pc >>> 0).toString(16)}`;
  if (t.cause === CAUSE_ILLEGAL)
    return `unimplemented or illegal CPU instruction (0x${(t.tval >>> 0).toString(16)} @ pc ${pc}) — the RISC-V interpreter does not support it yet`;
  if (t.cause === CAUSE_ECALL_M) return `firmware exited via a system call (ECALL @ pc ${pc})`;
  if (t.cause === CAUSE_BREAKPOINT)
    return `firmware aborted (EBREAK @ pc ${pc}) — e.g. assert()/abort()/__builtin_trap`;
  return `firmware trap cause=${t.cause} @ pc ${pc}`;
}

/** Runner construction options. A bare `number` is still accepted for the legacy `cyclesPerMs` arg. */
export interface Rv32RunnerOpts extends SocNetworkOpts {
  cyclesPerMs?: number;
}

export class Rv32Runner {
  readonly bus: SimpleBus;
  readonly cpu: Rv32Cpu;
  readonly gpio = new C3Gpio();
  readonly uart = new C3Uart();
  readonly adc = new C3Adc();
  readonly i2c = new C3I2c();
  readonly ledc = new C3Ledc();
  /** The network MMIO peripheral, present only when a transport was supplied (else firmware has no net). */
  readonly net: C3Net | null = null;
  /** Every GPIO pin the firmware has driven → its level (the sim worker reflects these). */
  readonly pins: Record<number, 0 | 1> = {};
  /** Optional per-instruction hook (the device-runtime bridge fires due events + sensor ticks here). */
  beforeStep?: () => void;
  private readonly timer: C3SysTimer;
  private readonly cyclesPerMs: number;
  private _halted = false;
  private _haltReason: string | null = null;
  /** True once the firmware trapped (an unimplemented/illegal instruction, or an abort/ECALL). The run
   *  is DEAD — the worker must stop and surface {@link haltReason} rather than present the frozen
   *  pre-trap output as a completed, correct run (that would be a silent fake). */
  get halted(): boolean {
    return this._halted;
  }
  /** Human-readable cause of the halt (instruction + pc), or null while still running. */
  get haltReason(): string | null {
    return this._haltReason;
  }

  constructor(firmware: Uint8Array, opts: number | Rv32RunnerOpts = {}) {
    const o: Rv32RunnerOpts = typeof opts === 'number' ? { cyclesPerMs: opts } : opts;
    this.cyclesPerMs = o.cyclesPerMs ?? DEFAULT_CYCLES_PER_MS;
    this.bus = new SimpleBus(new Uint8Array(RAM_SIZE));
    this.cpu = new Rv32Cpu(this.bus);
    this.timer = new C3SysTimer(() => this.cpu.cycles, this.cyclesPerMs);
    this.gpio.onChange = (pin, level) => {
      this.pins[pin] = level;
    };
    this.bus.map(C3_UART0_BASE, 0x80, this.uart);
    this.bus.map(C3_GPIO_BASE, 0x800, this.gpio);
    this.bus.map(C3_SYSTIMER_BASE, 0x10, this.timer);
    this.bus.map(C3_I2C0_BASE, 0x20, this.i2c);
    this.bus.map(C3_ADC_BASE, 0x100, this.adc); // 0x100 covers all 40 channels (ch N at N*4 → ch 34 = 0x88)
    this.bus.map(C3_LEDC_BASE, 0x100, this.ledc);
    if (o.transport) {
      this.net = new C3Net(o.transport, o.mqtt, o.blynk);
      this.bus.map(C3_NET_BASE, 0x100, this.net); // WiFi/HTTP/MQTT/Blynk HAL → transport (Tier 1 fake / Tier 2 fetch)
    }

    const { entry, segments } = elfLoad(firmware);
    for (const s of segments) this.bus.ram.set(s.data, s.addr);
    this.cpu.pc = entry;
    this.cpu.setReg(2, STACK_TOP); // stack pointer
  }

  /** Virtual time, in nanoseconds (host-speed independent — invariant I3). */
  get virtualTimeNs(): number {
    return (this.cpu.cycles / this.cyclesPerMs) * 1e6;
  }

  /** Advance ~ms of virtual time (cycles), or stop early if the firmware traps/halts. */
  executeForMillis(ms: number): void {
    if (this._halted) return;
    const target = this.cpu.cycles + ms * this.cyclesPerMs;
    const budget = Math.max(1, ms) * MAX_STEPS_PER_MS;
    let steps = 0;
    while (this.cpu.cycles < target && steps < budget) {
      try {
        this.beforeStep?.();
        this.cpu.step();
      } catch (e) {
        if (e instanceof Rv32Trap) {
          this._halted = true;
          this._haltReason = rv32HaltReason(e);
          return;
        }
        throw e;
      }
      steps++;
    }
  }

  serial(): string {
    return this.uart.text();
  }
  /** Button/digital input on a GPIO pin (released = HIGH, pressed = LOW for INPUT_PULLUP). */
  setInput(pin: number, level: 0 | 1): void {
    this.gpio.setInput(pin, level);
  }
  /** Analog input on an ADC channel (0..4095 on the C3). */
  setAdc(channel: number, raw: number): void {
    this.adc.set(channel, raw);
  }
}
