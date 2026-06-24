/**
 * Virtual Time Kernel (VTK) — REFERENCE-SPEC Stage 3, the carrier of invariant I3
 * (event-driven + virtual-time). A priority queue of callbacks keyed by virtual time
 * in nanoseconds; the kernel ONLY processes scheduled events (no whole-circuit tick)
 * and time advances solely by draining the queue — never from wall-clock. This is
 * what makes a simulation reproducible regardless of how fast it's run (a gate-#2
 * requirement: same result at throttled and fast-forward wall speeds).
 *
 * Ordering is deterministic: earliest virtual time first, ties broken by insertion
 * order (FIFO). Callbacks may schedule further events at or after `now()`; scheduling
 * in the past throws (it would violate causality / I3).
 */

export type EventCallback = () => void;

interface ScheduledEvent {
  id: number;
  timeNs: number;
  seq: number;
  cb: EventCallback;
  cancelled: boolean;
}

/** Min-heap ordered by (timeNs, seq) — both ascending. */
function lessThan(a: ScheduledEvent, b: ScheduledEvent): boolean {
  return a.timeNs < b.timeNs || (a.timeNs === b.timeNs && a.seq < b.seq);
}

export class VirtualTimeKernel {
  private heap: ScheduledEvent[] = [];
  private byId = new Map<number, ScheduledEvent>();
  private timeNs = 0;
  private seqCounter = 0;
  private idCounter = 0;

  /** Current virtual time in nanoseconds. */
  now(): number {
    return this.timeNs;
  }

  /** Number of live (non-cancelled) events still queued. */
  get pending(): number {
    return this.byId.size;
  }

  /** Schedule `cb` to fire `delayNs` (≥ 0) from now. Returns a cancellation id. */
  schedule(delayNs: number, cb: EventCallback): number {
    if (!Number.isFinite(delayNs) || delayNs < 0) {
      throw new Error(`VTK.schedule: delayNs must be ≥ 0 (got ${delayNs})`);
    }
    return this.scheduleAt(this.timeNs + delayNs, cb);
  }

  /** Schedule `cb` at an absolute virtual time (≥ now). Returns a cancellation id. */
  scheduleAt(timeNs: number, cb: EventCallback): number {
    if (!Number.isFinite(timeNs) || timeNs < this.timeNs) {
      throw new Error(
        `VTK.scheduleAt: cannot schedule in the past (now=${this.timeNs}, at=${timeNs})`,
      );
    }
    const ev: ScheduledEvent = {
      id: ++this.idCounter,
      timeNs,
      seq: this.seqCounter++,
      cb,
      cancelled: false,
    };
    this.byId.set(ev.id, ev);
    this.heapPush(ev);
    return ev.id;
  }

  /** Cancel a scheduled event (no-op if already fired/cancelled). */
  cancel(id: number): void {
    const ev = this.byId.get(id);
    if (ev) {
      ev.cancelled = true;
      this.byId.delete(ev.id);
    }
  }

  /** Virtual time of the next pending event, or null if the queue is empty. */
  nextEventTime(): number | null {
    this.dropCancelledTop();
    return this.heap.length ? this.heap[0]!.timeNs : null;
  }

  /**
   * Advance virtual time to `untilNs`, firing every event with time ≤ untilNs in
   * order. Time ends exactly at `untilNs` (even if no event lands there). Events a
   * callback schedules at ≤ untilNs run within the same call.
   */
  runUntil(untilNs: number): void {
    if (untilNs < this.timeNs) throw new Error(`VTK.runUntil: ${untilNs} < now ${this.timeNs}`);
    for (;;) {
      this.dropCancelledTop();
      const top = this.heap[0];
      if (!top || top.timeNs > untilNs) break;
      this.heapPop();
      this.byId.delete(top.id);
      this.timeNs = top.timeNs; // time only advances through the queue (I3)
      top.cb();
    }
    this.timeNs = untilNs;
  }

  /** Drain the entire queue (advance to the last event). For tests/headless runs. */
  runAll(): void {
    for (;;) {
      this.dropCancelledTop();
      const top = this.heap[0];
      if (!top) break;
      this.heapPop();
      this.byId.delete(top.id);
      this.timeNs = top.timeNs;
      top.cb();
    }
  }

  // ── binary min-heap ─────────────────────────────────────────────────────
  private dropCancelledTop(): void {
    while (this.heap.length && this.heap[0]!.cancelled) this.heapPop();
  }

  private heapPush(ev: ScheduledEvent): void {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (lessThan(h[i]!, h[parent]!)) {
        [h[i], h[parent]] = [h[parent]!, h[i]!];
        i = parent;
      } else break;
    }
  }

  private heapPop(): void {
    const h = this.heap;
    const last = h.pop()!;
    if (!h.length) return;
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < h.length && lessThan(h[l]!, h[smallest]!)) smallest = l;
      if (r < h.length && lessThan(h[r]!, h[smallest]!)) smallest = r;
      if (smallest === i) break;
      [h[i], h[smallest]] = [h[smallest]!, h[i]!];
      i = smallest;
    }
  }
}
