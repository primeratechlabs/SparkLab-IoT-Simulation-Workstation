/**
 * STAGE 3 QA — invariant I3 made EMPIRICAL, not just structural.
 *
 * The kernel never reads wall-clock, so a run's outcome cannot depend on how fast it is
 * driven. The other VTK tests assert determinism of a single drain; here we prove the
 * stronger gate-#2 property directly: the SAME event schedule, driven by three different
 * pacing strategies (one big fast-forward, many tiny 1 ns steps, irregular chunks), produces
 * a byte-identical firing log — exactly what "same result at throttled and fast-forward wall
 * speeds" means. Callbacks that schedule further events and ties at equal virtual time are
 * included so ordering (timeNs, seq) is exercised, not just leaf events.
 */
import { describe, it, expect } from 'vitest';
import { VirtualTimeKernel } from './vtk.js';

/** Build a fresh kernel with a fixed nested schedule, run it via `drive`, return the firing log. */
function runWith(drive: (k: VirtualTimeKernel) => void): string[] {
  const k = new VirtualTimeKernel();
  const log: string[] = [];
  const fire = (tag: string) => log.push(`${k.now()}:${tag}`);

  k.schedule(100, () => {
    fire('a');
    k.schedule(50, () => fire('a2'));
  }); // a2 at 150
  k.schedule(100, () => fire('b')); // ties with a at t=100 (FIFO by seq)
  k.schedule(30, () => {
    fire('c');
    k.schedule(70, () => fire('c2'));
  }); // c2 at 100, after a/b
  k.schedule(200, () => fire('d'));

  drive(k);
  return log;
}

describe('VTK — virtual-time independence (I3 / gate #2)', () => {
  const EXPECTED = ['30:c', '100:a', '100:b', '100:c2', '150:a2', '200:d'];

  it('fast-forward, 1 ns steps and irregular chunks all yield the identical firing log', () => {
    const fastForward = runWith((k) => k.runAll());
    const tinySteps = runWith((k) => {
      for (let t = 1; t <= 300; t++) k.runUntil(t);
    });
    const chunks = runWith((k) => {
      for (const t of [7, 30, 31, 99, 100, 101, 175, 300]) k.runUntil(t);
    });

    expect(fastForward).toEqual(EXPECTED);
    expect(tinySteps).toEqual(EXPECTED); // pacing changed; result did not (I3)
    expect(chunks).toEqual(EXPECTED);
  });

  it('the same schedule reaches the same final virtual time regardless of step granularity', () => {
    // runAll stops at the last event (200); bounded drivers end at their bound — but every
    // event fires at the same virtual time in every case (asserted above). Here we confirm a
    // bounded drive that covers all events lands time exactly at its bound, deterministically.
    const k1 = new VirtualTimeKernel();
    const k2 = new VirtualTimeKernel();
    for (const k of [k1, k2]) {
      k.schedule(40, () => k.schedule(40, () => {}));
      k.schedule(90, () => {});
    }
    for (let t = 1; t <= 250; t++) k1.runUntil(t); // tiny steps
    k2.runUntil(250); // one jump
    expect(k1.now()).toBe(250);
    expect(k2.now()).toBe(250);
    expect(k1.pending).toBe(0);
    expect(k2.pending).toBe(0);
  });
});
