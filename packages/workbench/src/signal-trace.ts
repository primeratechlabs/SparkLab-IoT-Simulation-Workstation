/**
 * Signal capture for the workbench inspectors (logic analyzer / waveform viewer).
 * A SignalTrace stores only value CHANGES (a transition list) keyed by virtual time
 * — event-driven, no per-sample storage — in a bounded ring buffer so a long run
 * can't grow without limit (invariant I9). The LogicAnalyzer captures many channels.
 *
 * Pure data structures: the OffscreenCanvas renderer turns these into geometry; the
 * main thread never touches the hot pixels (invariant I2).
 */

export interface Transition {
  tNs: number;
  value: number;
}

export class SignalTrace {
  private readonly buf: Transition[] = [];
  private head = 0; // index of the oldest live transition
  private last: number | null = null;

  constructor(
    readonly name: string,
    readonly capacity = 8192,
  ) {}

  /** Record a value at virtual time `tNs`. No-op if the value didn't change. */
  record(tNs: number, value: number): void {
    if (value === this.last) return;
    this.last = value;
    if (this.buf.length - this.head >= this.capacity) this.head++; // drop oldest
    this.buf.push({ tNs, value });
    if (this.head > this.capacity) {
      this.buf.splice(0, this.head); // compact occasionally
      this.head = 0;
    }
  }

  /** Live transitions in chronological order. */
  transitions(): Transition[] {
    return this.buf.slice(this.head);
  }

  get count(): number {
    return this.buf.length - this.head;
  }

  /** Transitions overlapping [startNs, endNs], plus the one in effect at startNs. */
  transitionsInWindow(startNs: number, endNs: number): Transition[] {
    const live = this.transitions();
    const out: Transition[] = [];
    let prior: Transition | null = null;
    for (const t of live) {
      if (t.tNs < startNs) prior = t;
      else if (t.tNs <= endNs) out.push(t);
    }
    if (prior) out.unshift({ tNs: startNs, value: prior.value });
    return out;
  }

  /** The signal value in effect at `tNs` (0 before the first transition). */
  valueAt(tNs: number): number {
    let v = 0;
    for (const t of this.transitions()) {
      if (t.tNs > tNs) break;
      v = t.value;
    }
    return v;
  }
}

export class LogicAnalyzer {
  private readonly traces = new Map<string, SignalTrace>();

  constructor(
    readonly maxChannels = 16,
    private readonly capacity = 8192,
  ) {}

  /** Add (or get) a channel. Throws past the channel budget (I9). */
  channel(name: string): SignalTrace {
    let t = this.traces.get(name);
    if (!t) {
      if (this.traces.size >= this.maxChannels) {
        throw new Error(`logic analyzer channel budget exceeded (${this.maxChannels})`);
      }
      t = new SignalTrace(name, this.capacity);
      this.traces.set(name, t);
    }
    return t;
  }

  record(name: string, tNs: number, value: number): void {
    this.channel(name).record(tNs, value);
  }

  channels(): SignalTrace[] {
    return [...this.traces.values()];
  }
}
