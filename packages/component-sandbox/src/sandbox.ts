/**
 * ComponentSandbox — REFERENCE-SPEC Stage 3 (gate #6). Runs a component's behavior in
 * an isolated Worker with a time-budget watchdog: each call posts work to the Worker
 * and waits for a reply; if the Worker overruns the budget (e.g. an infinite loop) the
 * watchdog terminates it and the call resolves as `killed`. The Worker is created
 * behind the SandboxWorker interface so the logic unit-tests with a fake worker + fake
 * clock; the browser adapter wraps a real Worker whose entry has called `lockdownScope`.
 */

import { Watchdog, type WatchdogClock } from './watchdog.js';

export interface SandboxWorker {
  postMessage(message: unknown): void;
  onMessage(cb: (message: unknown) => void): void;
  terminate(): void;
}

export interface SandboxResult {
  status: 'ok' | 'killed' | 'terminated';
  value?: unknown;
  reason?: string;
}

export class ComponentSandbox {
  private terminated = false;
  private pending: ((message: unknown) => void) | null = null;
  private pendingResult: ((result: SandboxResult) => void) | null = null;
  private activeWatchdog: Watchdog | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly worker: SandboxWorker,
    private readonly budgetMs: number,
    clock?: WatchdogClock,
  ) {
    this.clock = clock;
    this.worker.onMessage((message) => this.pending?.(message));
  }
  private readonly clock?: WatchdogClock;

  /**
   * Run one unit of work in the sandbox. Resolves `ok` with the Worker's reply, or
   * `killed` (and terminates the Worker) if it doesn't reply within the time budget.
   * Calls are serialized so concurrent callers cannot overwrite the active reply
   * handler or leave an earlier promise unresolved.
   */
  call(input: unknown): Promise<SandboxResult> {
    const result = this.queue.then(() => this.execute(input));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private execute(input: unknown): Promise<SandboxResult> {
    return new Promise((resolve) => {
      if (this.terminated)
        return resolve({ status: 'terminated', reason: 'sandbox already terminated' });

      const watchdog = new Watchdog(
        this.budgetMs,
        () => {
          this.pending = null;
          this.pendingResult = null;
          this.activeWatchdog = null;
          this.terminated = true;
          this.worker.terminate();
          resolve({ status: 'killed', reason: `time budget ${this.budgetMs}ms exceeded` });
        },
        this.clock,
      );
      this.activeWatchdog = watchdog;
      this.pendingResult = resolve;
      this.pending = (message) => {
        watchdog.disarm();
        this.activeWatchdog = null;
        this.pending = null;
        this.pendingResult = null;
        resolve({ status: 'ok', value: message });
      };
      watchdog.arm();
      this.worker.postMessage(input);
    });
  }

  terminate(): void {
    if (!this.terminated) {
      this.terminated = true;
      this.activeWatchdog?.disarm();
      this.activeWatchdog = null;
      this.pending = null;
      this.worker.terminate();
      const settle = this.pendingResult;
      this.pendingResult = null;
      settle?.({ status: 'terminated', reason: 'sandbox terminated' });
    }
  }

  get killed(): boolean {
    return this.terminated;
  }
}
