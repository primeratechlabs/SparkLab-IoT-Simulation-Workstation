/**
 * Worker pool skeleton (invariant I2 — keep heavy work off the main thread).
 *
 * Generic and dependency-free: callers supply a `spawn` factory that returns a
 * handle (e.g. a Comlink-wrapped remote) and a matching `terminate`. The pool
 * round-robins handles and exposes a simple concurrency-limited `run`. The real
 * Worker + Comlink wiring lives in /packages/app so this stays framework-free.
 */

export interface WorkerHandle<T> {
  remote: T;
  terminate(): void;
}

export interface WorkerPoolOptions {
  /** Number of workers to spawn. Defaults to hardwareConcurrency-aware caller value. */
  size: number;
}

export class WorkerPool<T> {
  private handles: WorkerHandle<T>[] = [];
  private rr = 0;
  private active = 0;
  private waiters: Array<() => void> = [];
  private terminated = false;

  constructor(
    private readonly spawn: () => WorkerHandle<T>,
    private readonly options: WorkerPoolOptions,
  ) {
    const size = Math.max(1, Math.floor(options.size));
    for (let i = 0; i < size; i++) this.handles.push(spawn());
  }

  get size(): number {
    return this.handles.length;
  }

  /** Pick the next remote round-robin (no concurrency gating). */
  next(): T {
    if (this.handles.length === 0) throw new Error('worker pool has no workers');
    const h = this.handles[this.rr]!;
    // Keep rr bounded: a bare rr++ loses precision past MAX_SAFE_INTEGER and
    // would collapse the modulo back to worker 0.
    this.rr = (this.rr + 1) % this.handles.length;
    return h.remote;
  }

  /** Run a job on a remote, capped at `size` concurrent jobs (FIFO queue). */
  async run<R>(job: (remote: T) => Promise<R>): Promise<R> {
    if (this.terminated) throw new Error('worker pool terminated');
    // Loop (not `if`): re-check capacity after each wake-up so two parked waiters
    // resuming from one freed slot can't both pass the gate (TOCTOU fix).
    while (this.active >= this.handles.length) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (this.terminated) throw new Error('worker pool terminated');
    }
    this.active++;
    try {
      return await job(this.next());
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  terminateAll(): void {
    this.terminated = true;
    for (const h of this.handles) h.terminate();
    this.handles = [];
    // Wake parked waiters so they don't hang forever; they re-check `terminated`.
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
