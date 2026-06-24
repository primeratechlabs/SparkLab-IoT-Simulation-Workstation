import { describe, it, expect } from 'vitest';
import { WorkerPool, type WorkerHandle } from './worker-pool.js';

interface FakeRemote {
  id: number;
}

function makePool(size: number): { pool: WorkerPool<FakeRemote>; terminated: number[] } {
  let n = 0;
  const terminated: number[] = [];
  const pool = new WorkerPool<FakeRemote>(
    (): WorkerHandle<FakeRemote> => {
      const id = n++;
      return { remote: { id }, terminate: () => terminated.push(id) };
    },
    { size },
  );
  return { pool, terminated };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('WorkerPool', () => {
  it('caps concurrency at the pool size', async () => {
    const { pool } = makePool(2);
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => pool.run(job)));
    expect(maxActive).toBe(2);
  });

  it('runs all queued jobs to completion (FIFO, no lost jobs)', async () => {
    const { pool } = makePool(1);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        pool.run(async () => {
          await tick();
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('terminateAll terminates workers and wakes parked waiters (no hang)', async () => {
    const { pool, terminated } = makePool(1);
    // Occupy the single worker with a long job, queue a second.
    let releaseFirst!: () => void;
    const first = pool.run(async () => {
      await new Promise<void>((r) => (releaseFirst = r));
    });
    const second = pool.run(async () => undefined);
    await tick(); // let `second` park as a waiter
    pool.terminateAll();
    releaseFirst();
    await expect(second).rejects.toThrow(/terminated/);
    await first;
    expect(terminated).toEqual([0]);
  });

  it('rejects run() after termination and next() on an empty pool', async () => {
    const { pool } = makePool(1);
    pool.terminateAll();
    await expect(pool.run(async () => 1)).rejects.toThrow(/terminated/);
    expect(() => pool.next()).toThrow(/no workers/);
  });

  it('next() cycles round-robin across all workers and wraps cleanly', () => {
    const { pool } = makePool(3);
    const seen = Array.from({ length: 9 }, () => pool.next().id);
    expect(seen).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
  });

  it('keeps round-robin correct once the counter passes MAX_SAFE_INTEGER', () => {
    const { pool } = makePool(3);
    // Drive the internal counter to the edge of float precision: a bare rr++
    // here would lose precision and pin every pick to worker 0.
    (pool as unknown as { rr: number }).rr = Number.MAX_SAFE_INTEGER % 3;
    const seen = Array.from({ length: 6 }, () => pool.next().id);
    const expectedFirst = Number.MAX_SAFE_INTEGER % 3;
    expect(seen).toEqual([
      expectedFirst,
      (expectedFirst + 1) % 3,
      (expectedFirst + 2) % 3,
      expectedFirst,
      (expectedFirst + 1) % 3,
      (expectedFirst + 2) % 3,
    ]);
    // The counter must stay bounded, never growing unboundedly toward Infinity.
    expect((pool as unknown as { rr: number }).rr).toBeLessThan(3);
  });
});
