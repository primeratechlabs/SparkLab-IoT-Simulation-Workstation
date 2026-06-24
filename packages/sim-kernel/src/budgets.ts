/**
 * Circuit budgets — REFERENCE-SPEC Stage 3. Enforces `CircuitBudgets` (types.ts) so a
 * pathological circuit degrades gracefully instead of hanging the tab (invariant I9):
 * static limits are reported as violations; the event-rate limiter sheds load.
 */

import type { CircuitBudgets } from '@sparklab/shared';

export const DEFAULT_BUDGETS: CircuitBudgets = {
  maxComponents: 64,
  maxNets: 128,
  maxEventRate: 200_000, // events/sec (virtual time)
  maxLogicAnalyzerChannels: 16,
  maxWaveformDurationMs: 5_000,
  maxProtocolTxPerSecond: 50_000,
  maxAnalogIslands: 8,
  maxSpiceNodes: 64,
};

export interface CircuitUsage {
  components: number;
  nets: number;
  analogIslands: number;
  logicAnalyzerChannels: number;
}

export interface BudgetViolation {
  budget: keyof CircuitBudgets;
  limit: number;
  actual: number;
  message: string;
}

/** Check static circuit size against budgets (call when topology changes). */
export function checkBudgets(
  usage: CircuitUsage,
  budgets: CircuitBudgets = DEFAULT_BUDGETS,
): BudgetViolation[] {
  const v: BudgetViolation[] = [];
  const test = (key: keyof CircuitBudgets, actual: number): void => {
    const limit = budgets[key];
    if (actual > limit)
      v.push({ budget: key, limit, actual, message: `${key} ${actual} exceeds ${limit}` });
  };
  test('maxComponents', usage.components);
  test('maxNets', usage.nets);
  test('maxAnalogIslands', usage.analogIslands);
  test('maxLogicAnalyzerChannels', usage.logicAnalyzerChannels);
  return v;
}

/**
 * Sliding-window rate limiter on virtual time (ns). `allow(nowNs)` returns false once
 * the configured per-second rate is exceeded in the trailing 1s window, letting the
 * caller drop/coalesce events rather than flooding the bridge (I9).
 */
export class EventRateLimiter {
  private readonly window: number[] = [];
  private head = 0;
  constructor(private readonly maxPerSecond: number) {}

  allow(nowNs: number): boolean {
    const cutoff = nowNs - 1_000_000_000; // 1 second in ns
    while (this.head < this.window.length && this.window[this.head]! < cutoff) this.head++;
    if (this.head > 4096) {
      this.window.splice(0, this.head); // compact occasionally
      this.head = 0;
    }
    if (this.window.length - this.head >= this.maxPerSecond) return false;
    this.window.push(nowNs);
    return true;
  }

  get currentRate(): number {
    return this.window.length - this.head;
  }
}
