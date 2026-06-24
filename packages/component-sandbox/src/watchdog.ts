/**
 * Watchdog — REFERENCE-SPEC Stage 3 sandbox (gate #6). WASM in the browser has no fuel
 * or epoch interrupt, so a runaway component (infinite loop) can only be stopped by
 * terminating its Worker from the outside. The Watchdog arms a deadline; if the work
 * doesn't `done()` within the time budget, `onExpire` fires (the sandbox terminates the
 * Worker). The clock is injectable so it unit-tests with fake timers.
 */

export interface WatchdogClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class Watchdog {
  private handle: unknown = null;
  private fired = false;

  constructor(
    private readonly budgetMs: number,
    private readonly onExpire: () => void,
    private readonly clock: WatchdogClock = globalThis as unknown as WatchdogClock,
  ) {}

  /** Arm (or re-arm) the deadline. */
  arm(): void {
    this.disarm();
    this.fired = false;
    this.handle = this.clock.setTimeout(() => {
      this.handle = null;
      this.fired = true;
      this.onExpire();
    }, this.budgetMs);
  }

  /** Reset the deadline because the component made cooperative progress. */
  kick(): void {
    if (this.handle !== null) this.arm();
  }

  /** Work finished in time — cancel the deadline. */
  disarm(): void {
    if (this.handle !== null) {
      this.clock.clearTimeout(this.handle);
      this.handle = null;
    }
  }

  get armed(): boolean {
    return this.handle !== null;
  }
  get expired(): boolean {
    return this.fired;
  }
}
