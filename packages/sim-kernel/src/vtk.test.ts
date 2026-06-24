import { describe, it, expect } from 'vitest';
import { VirtualTimeKernel } from './vtk.js';

describe('VirtualTimeKernel (invariant I3)', () => {
  it('fires events in virtual-time order regardless of insertion order', () => {
    const k = new VirtualTimeKernel();
    const log: number[] = [];
    k.scheduleAt(300, () => log.push(300));
    k.scheduleAt(100, () => log.push(100));
    k.scheduleAt(200, () => log.push(200));
    k.runAll();
    expect(log).toEqual([100, 200, 300]);
    expect(k.now()).toBe(300);
  });

  it('breaks ties by insertion order (FIFO at the same virtual time)', () => {
    const k = new VirtualTimeKernel();
    const log: string[] = [];
    k.scheduleAt(50, () => log.push('a'));
    k.scheduleAt(50, () => log.push('b'));
    k.scheduleAt(50, () => log.push('c'));
    k.runAll();
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('advances time only through the queue; now() reflects the firing event time', () => {
    const k = new VirtualTimeKernel();
    const times: number[] = [];
    k.schedule(1000, () => times.push(k.now()));
    k.schedule(2500, () => times.push(k.now()));
    k.runAll();
    expect(times).toEqual([1000, 2500]);
  });

  it('runUntil fires events up to and including the bound, then stops there', () => {
    const k = new VirtualTimeKernel();
    const log: number[] = [];
    k.scheduleAt(100, () => log.push(100));
    k.scheduleAt(200, () => log.push(200));
    k.scheduleAt(300, () => log.push(300));
    k.runUntil(200);
    expect(log).toEqual([100, 200]);
    expect(k.now()).toBe(200);
    expect(k.pending).toBe(1); // the 300 event remains
    k.runUntil(300);
    expect(log).toEqual([100, 200, 300]);
  });

  it('lets callbacks schedule further events (same run), preserving order', () => {
    const k = new VirtualTimeKernel();
    const log: number[] = [];
    k.schedule(100, () => {
      log.push(100);
      k.schedule(50, () => log.push(150)); // now=100 → fires at 150
    });
    k.scheduleAt(200, () => log.push(200));
    k.runUntil(1000);
    expect(log).toEqual([100, 150, 200]);
  });

  it('supports cancellation', () => {
    const k = new VirtualTimeKernel();
    const log: number[] = [];
    k.scheduleAt(100, () => log.push(100));
    const id = k.scheduleAt(150, () => log.push(150));
    k.scheduleAt(200, () => log.push(200));
    k.cancel(id);
    k.runAll();
    expect(log).toEqual([100, 200]);
  });

  it('rejects scheduling in the past (causality / I3)', () => {
    const k = new VirtualTimeKernel();
    k.runUntil(500);
    expect(() => k.scheduleAt(400, () => {})).toThrow(/past/);
    expect(() => k.schedule(-1, () => {})).toThrow(/≥ 0/);
  });

  it('is reproducible: identical schedules → identical firing order + end time', () => {
    const build = (): { order: number[]; end: number } => {
      const k = new VirtualTimeKernel();
      const order: number[] = [];
      for (const [t, v] of [
        [300, 3],
        [100, 1],
        [100, 2],
        [200, 4],
      ] as const) {
        k.scheduleAt(t, () => order.push(v));
      }
      k.runAll();
      return { order, end: k.now() };
    };
    expect(build()).toEqual(build());
  });

  it('reports the next event time and empties cleanly', () => {
    const k = new VirtualTimeKernel();
    expect(k.nextEventTime()).toBeNull();
    k.scheduleAt(420, () => {});
    expect(k.nextEventTime()).toBe(420);
    k.runAll();
    expect(k.nextEventTime()).toBeNull();
    expect(k.pending).toBe(0);
  });

  it('nextEventTime() is null after cancelling the only event', () => {
    const k = new VirtualTimeKernel();
    const id = k.scheduleAt(100, () => {});
    expect(k.nextEventTime()).toBe(100);
    k.cancel(id);
    expect(k.nextEventTime()).toBeNull();
    expect(k.pending).toBe(0);
  });

  it('cancelling an event then scheduling a fresh one at the same time fires only the new one', () => {
    const k = new VirtualTimeKernel();
    const log: string[] = [];
    const id = k.scheduleAt(100, () => log.push('cancelled'));
    k.cancel(id);
    k.scheduleAt(100, () => log.push('fresh')); // same virtual time as the cancelled one
    expect(k.nextEventTime()).toBe(100);
    expect(k.pending).toBe(1);
    k.runAll();
    expect(log).toEqual(['fresh']);
    expect(k.now()).toBe(100);
  });

  it('a callback may schedule another event at the same virtual time (fires this run, after siblings)', () => {
    const k = new VirtualTimeKernel();
    const log: string[] = [];
    k.scheduleAt(100, () => {
      log.push('first@100');
      k.scheduleAt(100, () => log.push('reentrant@100')); // delay 0 from now=100
    });
    k.scheduleAt(100, () => log.push('second@100'));
    k.runUntil(100);
    // The re-entrant event has a later seq, so it fires after both pre-existing 100-events,
    // still within the same runUntil(100) call (time ≤ bound).
    expect(log).toEqual(['first@100', 'second@100', 'reentrant@100']);
    expect(k.now()).toBe(100);
    expect(k.pending).toBe(0);
  });
});
