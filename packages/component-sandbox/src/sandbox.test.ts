import { describe, it, expect } from 'vitest';
import { Watchdog, type WatchdogClock } from './watchdog.js';
import { lockdownScope, auditScope, FORBIDDEN_GLOBALS } from './capabilities.js';
import { ComponentSandbox, type SandboxWorker } from './sandbox.js';

/** Controllable clock: timers fire only when tick() is called. */
class FakeClock implements WatchdogClock {
  private timers = new Map<number, () => void>();
  private id = 0;
  setTimeout(handler: () => void): unknown {
    const id = ++this.id;
    this.timers.set(id, handler);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  tick(): void {
    const due = [...this.timers];
    this.timers.clear();
    for (const [, h] of due) h();
  }
}

/** Fake Worker: either replies synchronously to a message, or hangs (infinite loop). */
class FakeWorker implements SandboxWorker {
  terminated = false;
  private cb: ((m: unknown) => void) | null = null;
  constructor(
    private readonly behavior: 'reply' | 'hang',
    private readonly reply: unknown = 'done',
  ) {}
  postMessage(): void {
    if (this.behavior === 'reply') this.cb?.(this.reply);
  }
  onMessage(cb: (m: unknown) => void): void {
    this.cb = cb;
  }
  terminate(): void {
    this.terminated = true;
  }
}

class ControlledWorker implements SandboxWorker {
  messages: unknown[] = [];
  terminated = false;
  private cb: ((m: unknown) => void) | null = null;
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  onMessage(cb: (m: unknown) => void): void {
    this.cb = cb;
  }
  reply(message: unknown): void {
    this.cb?.(message);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('Watchdog', () => {
  it('fires onExpire after the budget if not disarmed', () => {
    const clock = new FakeClock();
    let expired = false;
    const wd = new Watchdog(100, () => (expired = true), clock);
    wd.arm();
    expect(wd.armed).toBe(true);
    clock.tick();
    expect(expired).toBe(true);
    expect(wd.expired).toBe(true);
  });

  it('does not fire if disarmed in time', () => {
    const clock = new FakeClock();
    let expired = false;
    const wd = new Watchdog(100, () => (expired = true), clock);
    wd.arm();
    wd.disarm();
    clock.tick();
    expect(expired).toBe(false);
  });
});

describe('capabilities lockdown', () => {
  it('strips every forbidden global from a worker scope', () => {
    const scope: Record<string, unknown> = {
      fetch: () => {},
      XMLHttpRequest: function () {},
      indexedDB: {},
      navigator: { storage: {} },
      document: {},
      localStorage: {},
      WebSocket: function () {},
      WebTransport: function () {},
      Worker: function () {},
      SharedWorker: function () {},
      BroadcastChannel: function () {},
      caches: {},
      importScripts: () => {},
      EventSource: function () {},
      sessionStorage: {},
      // a harmless global the component IS allowed to use
      Math,
    };
    const removed = lockdownScope(scope);
    expect(removed).toEqual(expect.arrayContaining([...FORBIDDEN_GLOBALS]));
    expect(auditScope(scope)).toEqual([]); // nothing forbidden remains reachable
    expect(scope.fetch).toBeUndefined();
    expect(scope.Math).toBe(Math); // allowed global untouched
  });
});

describe('ComponentSandbox', () => {
  it('returns the Worker reply when the component finishes within budget', async () => {
    const clock = new FakeClock();
    const sandbox = new ComponentSandbox(new FakeWorker('reply', 42), 100, clock);
    const result = await sandbox.call({ tick: 1 });
    expect(result).toEqual({ status: 'ok', value: 42 });
    expect(sandbox.killed).toBe(false);
  });

  it('KILLS a component that runs an infinite loop (watchdog terminates the Worker)', async () => {
    const clock = new FakeClock();
    const worker = new FakeWorker('hang');
    const sandbox = new ComponentSandbox(worker, 50, clock);
    const promise = sandbox.call({ tick: 1 });
    await Promise.resolve(); // queued call starts and arms its watchdog
    clock.tick(); // budget elapses with no reply
    const result = await promise;
    expect(result.status).toBe('killed');
    expect(worker.terminated).toBe(true); // the rogue Worker was terminated
    expect(sandbox.killed).toBe(true);
  });

  it('refuses further calls once terminated', async () => {
    const sandbox = new ComponentSandbox(new FakeWorker('hang'), 50, new FakeClock());
    sandbox.terminate();
    expect((await sandbox.call({})).status).toBe('terminated');
  });

  it('serializes concurrent calls without losing either reply', async () => {
    const worker = new ControlledWorker();
    const sandbox = new ComponentSandbox(worker, 100, new FakeClock());
    const first = sandbox.call('first');
    const second = sandbox.call('second');
    await Promise.resolve();
    expect(worker.messages).toEqual(['first']);

    worker.reply('reply-1');
    await expect(first).resolves.toEqual({ status: 'ok', value: 'reply-1' });
    await Promise.resolve();
    expect(worker.messages).toEqual(['first', 'second']);

    worker.reply('reply-2');
    await expect(second).resolves.toEqual({ status: 'ok', value: 'reply-2' });
  });

  it('settles an active call when explicitly terminated', async () => {
    const worker = new FakeWorker('hang');
    const sandbox = new ComponentSandbox(worker, 100, new FakeClock());
    const pending = sandbox.call('work');
    await Promise.resolve();
    sandbox.terminate();
    await expect(pending).resolves.toEqual({ status: 'terminated', reason: 'sandbox terminated' });
  });
});
