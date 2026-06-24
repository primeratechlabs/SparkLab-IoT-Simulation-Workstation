import { describe, it, expect } from 'vitest';
import { checkBudgets, EventRateLimiter, DEFAULT_BUDGETS } from './budgets.js';

describe('checkBudgets', () => {
  it('passes a circuit within limits', () => {
    expect(
      checkBudgets({ components: 5, nets: 8, analogIslands: 1, logicAnalyzerChannels: 2 }),
    ).toHaveLength(0);
  });

  it('reports each exceeded budget', () => {
    const v = checkBudgets(
      { components: 999, nets: 999, analogIslands: 99, logicAnalyzerChannels: 99 },
      DEFAULT_BUDGETS,
    );
    expect(v.map((x) => x.budget)).toEqual(
      expect.arrayContaining([
        'maxComponents',
        'maxNets',
        'maxAnalogIslands',
        'maxLogicAnalyzerChannels',
      ]),
    );
  });
});

describe('EventRateLimiter', () => {
  it('allows up to the rate then sheds load within a 1s window', () => {
    const rl = new EventRateLimiter(3);
    expect(rl.allow(0)).toBe(true);
    expect(rl.allow(100)).toBe(true);
    expect(rl.allow(200)).toBe(true);
    expect(rl.allow(300)).toBe(false); // 4th in the same second → dropped
  });

  it('recovers after the window slides past old events', () => {
    const rl = new EventRateLimiter(2);
    expect(rl.allow(0)).toBe(true);
    expect(rl.allow(1)).toBe(true);
    expect(rl.allow(2)).toBe(false);
    // 1.1s later the first two events have aged out.
    expect(rl.allow(1_100_000_000)).toBe(true);
  });
});
