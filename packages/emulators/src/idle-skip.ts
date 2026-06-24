/**
 * Stage 7 — tickless fast-forward (idle-skip). A firmware `delay(ms)` busy-loops reading the
 * cycle-derived millis timer; the emulator otherwise burns `ms * cyclesPerMs` instructions
 * spinning. idle-skip recognises that spin and elides the dead iterations.
 *
 * BYTE-IDENTICAL guarantee (preserves I3/I4): the only iterations skipped are ones where the
 * millis value the firmware reads is UNCHANGED — those iterations are provably no-ops (same read,
 * same registers, same branch, only `cycles` advances). We jump `cpu.cycles` by exactly the
 * instructions those iterations would have retired (whole loop periods), so the CPU lands on the
 * exact cycle a non-skipped run would reach at the next millis change. Final registers / RAM /
 * cycles / observable trace are identical to running every instruction — just far fewer steps.
 *
 * Safety rails: skip ONLY clean millis-read spins (no writes, no other data reads); require a
 * STABLE loop period (two equal periods) before jumping; never overshoot a millis change; any
 * non-timer data access or write breaks the spin and falls back to plain stepping.
 */
import type { Rv32Bus } from './rv32.js';

/** A CPU idle-skip can drive: single-step, a virtual-cycle counter, and a program counter. */
export interface SteppableCpu {
  step(): void;
  cycles: number;
  pc: number;
}

/**
 * Bus wrapper that classifies each access during a step as: an instruction FETCH (ignored — it
 * targets the current PC), a read of the millis register (the spin signal), or any other data
 * read / write (which makes the step "dirty" = not an idle spin). The owner sets `fetchPc` before
 * each step.
 */
export class MonitoredBus implements Rv32Bus {
  fetchPc = 0;
  dirty = false; // a write or a non-fetch, non-millis data read happened this step
  millisRead = false; // the millis register was read this step
  millisValue = 0;

  constructor(
    private readonly inner: Rv32Bus,
    private readonly millisAddr: number,
  ) {}

  /** Clear per-step flags (call before each cpu.step()). */
  reset(pc: number): void {
    this.fetchPc = pc >>> 0;
    this.dirty = false;
    this.millisRead = false;
  }

  private isFetch(a: number): boolean {
    const off = (a >>> 0) - this.fetchPc;
    return off >= 0 && off < 4; // instruction bytes of the current PC
  }
  private isMillis(a: number): boolean {
    const off = (a >>> 0) - this.millisAddr;
    return off >= 0 && off < 4;
  }
  private onRead(a: number, value: number): void {
    if (this.isFetch(a)) return; // instruction fetch — not a data access
    if (this.isMillis(a)) {
      this.millisRead = true;
      this.millisValue = value >>> 0;
    } else {
      this.dirty = true; // any other data read → not a pure timer spin
    }
  }

  read8(a: number): number {
    const v = this.inner.read8(a);
    this.onRead(a, v);
    return v;
  }
  read16(a: number): number {
    const v = this.inner.read16(a);
    this.onRead(a, v);
    return v;
  }
  read32(a: number): number {
    const v = this.inner.read32(a);
    this.onRead(a, v);
    return v;
  }
  write8(a: number, v: number): void {
    this.dirty = true;
    this.inner.write8(a, v);
  }
  write16(a: number, v: number): void {
    this.dirty = true;
    this.inner.write16(a, v);
  }
  write32(a: number, v: number): void {
    this.dirty = true;
    this.inner.write32(a, v);
  }
}

export interface IdleSkipOptions {
  /** Address of the cycle-derived millis register (e.g. C3_SYSTIMER_BASE + 0). */
  millisAddr: number;
  /** Cycles per millisecond — the timer's cycles→ms factor (C3SysTimer.cyclesPerMs). */
  cyclesPerMs: number;
  /** Hard cap on real instructions executed (runaway guard). */
  maxSteps: number;
  /** Stop predicate (e.g. enough output captured); checked between steps. */
  stopWhen?: () => boolean;
}

export interface IdleSkipResult {
  steps: number; // real cpu.step() calls executed
  skippedCycles: number; // virtual cycles fast-forwarded over (the saved work)
  stopped: 'predicate' | 'maxSteps';
}

interface ReadMark {
  cycle: number;
  value: number;
}

/**
 * Run `cpu` with idle-skip over `mbus`. Equivalent to stepping every instruction, but dead
 * millis-spin iterations are elided. Returns the real step count + the virtual cycles skipped.
 */
export function runWithIdleSkip(
  cpu: SteppableCpu,
  mbus: MonitoredBus,
  opts: IdleSkipOptions,
): IdleSkipResult {
  const r = opts.cyclesPerMs;
  let steps = 0;
  let skipped = 0;
  let prev: ReadMark | null = null;
  let prev2: ReadMark | null = null;

  while (steps < opts.maxSteps) {
    if (opts.stopWhen?.()) return { steps, skippedCycles: skipped, stopped: 'predicate' };

    const before = cpu.cycles;
    mbus.reset(cpu.pc);
    cpu.step();
    steps++;

    if (mbus.dirty) {
      // a write or other data read — not a spin; reset detection
      prev = null;
      prev2 = null;
      continue;
    }
    if (!mbus.millisRead) {
      // a register-only instruction inside the loop — stays in the spin, no state change
      continue;
    }

    // a clean millis read at cycle `before`
    const cur: ReadMark = { cycle: before, value: mbus.millisValue };
    if (
      prev !== null &&
      prev2 !== null &&
      cur.value === prev.value &&
      prev.value === prev2.value // three reads at the same millis → established spin
    ) {
      const p1 = prev.cycle - prev2.cycle;
      const p2 = cur.cycle - prev.cycle;
      if (p1 > 0 && p1 === p2) {
        // dead iterations until the next millis change, without overshooting it
        const nextChange = (Math.floor(cur.cycle / r) + 1) * r; // first cycle where millis increments
        const k = Math.ceil((nextChange - cur.cycle) / p2); // reads at cur, cur+p2, … ; k-th changes
        if (k >= 2) {
          const jump = (k - 1) * p2; // skip the k-1 dead iterations
          cpu.cycles += jump;
          skipped += jump;
        }
      }
    }
    prev2 = prev;
    prev = cur;
  }
  return { steps, skippedCycles: skipped, stopped: 'maxSteps' };
}
