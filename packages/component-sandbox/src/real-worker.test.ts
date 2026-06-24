/**
 * Stage 7 — sandbox abuse against a REAL Worker (gate #4). The other sandbox tests use a fake
 * worker; here we spawn a genuine worker thread, so the watchdog must kill a truly-hung worker via
 * a real terminate(), and the lockdown is verified inside a real worker scope. (Node worker_threads
 * stands in for the browser Worker; DOM/OPFS aren't present in Node, but fetch is, so the network
 * lockdown is exercised for real.)
 */
import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { ComponentSandbox, type SandboxWorker } from './sandbox.js';

const workerUrl = new URL('./__fixtures__/sandbox-worker.mjs', import.meta.url);

class NodeWorkerSandbox implements SandboxWorker {
  private readonly w = new Worker(workerUrl);
  postMessage(m: unknown): void {
    this.w.postMessage(m);
  }
  onMessage(cb: (m: unknown) => void): void {
    this.w.on('message', cb);
  }
  terminate(): void {
    void this.w.terminate();
  }
}

describe('component sandbox — REAL Worker abuse (Stage 7, gate #4)', () => {
  it('terminates a genuinely infinite-looping component (watchdog kills the real worker)', async () => {
    const sandbox = new ComponentSandbox(new NodeWorkerSandbox(), 250); // real timers, real worker
    const res = await sandbox.call({ cmd: 'loop' });
    expect(res.status).toBe('killed'); // the hung worker was forcibly terminated
    expect(sandbox.killed).toBe(true);
  }, 5000);

  it('a sandboxed component cannot reach fetch or storage (lockdown holds in a real worker)', async () => {
    const sandbox = new ComponentSandbox(new NodeWorkerSandbox(), 2000);
    const f = await sandbox.call({ cmd: 'tryFetch' });
    expect(f.status).toBe('ok');
    expect((f.value as { fetchAvailable: boolean }).fetchAvailable).toBe(false); // network stripped
    const s = await sandbox.call({ cmd: 'tryStorage' });
    expect((s.value as { storageAvailable: boolean }).storageAvailable).toBe(false); // storage stripped
    sandbox.terminate();
  }, 5000);

  it('normal work in a real worker replies ok', async () => {
    const sandbox = new ComponentSandbox(new NodeWorkerSandbox(), 2000);
    const res = await sandbox.call({ cmd: 'echo', value: 42 });
    expect(res.status).toBe('ok');
    expect((res.value as { echo: number }).echo).toBe(42);
    sandbox.terminate();
  }, 5000);
});
