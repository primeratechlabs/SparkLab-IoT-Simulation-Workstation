/**
 * XtensaRunner — the ESP32-classic analog of Rv32Runner/AVRRunner: it bundles the Xtensa (call0)
 * CPU, RAM bus, and the SAME SoC peripherals (GPIO/UART/SysTimer/I2C/ADC, reused from the C3 SoC —
 * the MMIO map is architecture-neutral) behind the identical surface the sim worker drives —
 * `executeForMillis(ms)` + `virtualTimeNs` + GPIO/serial taps + input setters — so the worker can
 * branch on board with a symmetric seam. Runs the sim-build-profile firmware ELF (flat, base 0).
 */
import { XtensaCpu, XtensaTrap } from './xtensa.js';
import { SimpleBus } from './rv32.js';
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
const DEFAULT_CYCLES_PER_MS = 50; // sim throughput mapping (low → delay() loops cost few cycles)
const MAX_STEPS_PER_MS = 200_000; // guard against firmware spinning forever (bounded run per tick)

/** Plain-language halt cause for the worker/UI. 'break' is an intentional abort/__builtin_trap; any
 *  other reason is an opcode the subset interpreter doesn't decode yet (a simulator limitation, not the
 *  user's bug) — surfaced so a half-run firmware is never presented as a completed, correct run. */
function xtensaHaltReason(t: XtensaTrap): string {
  const pc = `0x${(t.pc >>> 0).toString(16)}`;
  if (t.reason === 'break')
    return `firmware aborted (BREAK @ pc ${pc}) — e.g. assert()/abort()/__builtin_trap`;
  return `unimplemented CPU instruction (${t.reason}, 0x${(t.insn >>> 0).toString(16)} @ pc ${pc}) — ${xtensaTrapHint(t.reason)}`;
}

/** A one-line, human hint for the rare remaining decoder gaps, so a trap is legible in the UI instead of a
 *  bare opcode (xtensa-core audit P6 — louder, self-explaining traps). The interpreter is a WINDOWED-ABI LX6
 *  core; most ISA + the FP-division/sqrt option are implemented, so a trap here is genuinely uncommon. */
function xtensaTrapHint(reason: string): string {
  // FP0 (op1=10) / FP1 (op1=11) — a single-precision FP op not yet covered.
  if (/\bop1=1[01]\b/.test(reason)) {
    return 'an unhandled single-precision FP op (double-precision is soft-float; only an obscure FP-option opcode would land here)';
  }
  return 'an Xtensa instruction the interpreter does not decode yet — please report the opcode';
}

/** Runner construction options. A bare `number` is still accepted for the legacy `cyclesPerMs` arg. */
export interface XtensaRunnerOpts extends SocNetworkOpts {
  cyclesPerMs?: number;
}

export class XtensaRunner {
  readonly bus: SimpleBus;
  readonly cpu: XtensaCpu;
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
  /** True once the firmware trapped (an opcode the Xtensa interpreter doesn't implement, or a BREAK/
   *  abort). The run is DEAD — the worker must stop and surface {@link haltReason} rather than present
   *  the frozen pre-trap output as a completed, correct run (that would be a silent fake). */
  get halted(): boolean {
    return this._halted;
  }
  /** Human-readable cause of the halt (opcode + pc), or null while still running. */
  get haltReason(): string | null {
    return this._haltReason;
  }

  constructor(firmware: Uint8Array, opts: number | XtensaRunnerOpts = {}) {
    const o: XtensaRunnerOpts = typeof opts === 'number' ? { cyclesPerMs: opts } : opts;
    this.cyclesPerMs = o.cyclesPerMs ?? DEFAULT_CYCLES_PER_MS;
    this.bus = new SimpleBus(new Uint8Array(RAM_SIZE));
    this.cpu = new XtensaCpu(this.bus);
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
    this.cpu.setReg(1, STACK_TOP); // a1 = stack pointer (call0 ABI)
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
        if (e instanceof XtensaTrap) {
          this._halted = true;
          this._haltReason = xtensaHaltReason(e);
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
  /** Analog input on an ADC channel (0..4095). */
  setAdc(channel: number, raw: number): void {
    this.adc.set(channel, raw);
  }
}
