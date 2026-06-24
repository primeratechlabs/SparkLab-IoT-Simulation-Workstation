import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

// Mock the worker clients + the error translator so the lifecycle is deterministic.
const compileToHex = vi.fn();
const getState = vi.fn();
const loadHex = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const attachCircuit = vi.fn();
const setDeviceProp = vi.fn();
const setNetworkTier = vi.fn();
const getNetworkState = vi.fn();

vi.mock('../lib/build-client', () => ({ getBuild: () => ({ compileToHex }) }));
vi.mock('../lib/sim-client', () => ({
  getSim: () => ({
    getState,
    loadHex,
    start,
    stop,
    attachCircuit,
    setDeviceProp,
    setNetworkTier,
    getNetworkState,
  }),
}));
vi.mock('@sparklab/build-orchestrator', () => ({
  friendlyFor: (m: string) => (m.includes(';') ? 'thiếu dấu chấm phẩy' : undefined),
}));

import { useSimRunner } from './useSimRunner';

function withRunner() {
  let runner!: ReturnType<typeof useSimRunner>;
  const Comp = defineComponent({
    setup() {
      runner = useSimRunner();
      return () => null;
    },
  });
  const wrapper = mount(Comp);
  return { runner, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  compileToHex.mockResolvedValue({ hex: ':00000001FF', diagnostics: [] });
  getState.mockResolvedValue({
    pin13: true,
    ledToggles: 4,
    serial: 'blink',
    virtualTimeMs: 1000,
    running: true,
  });
  loadHex.mockResolvedValue(undefined);
  start.mockResolvedValue(undefined);
  stop.mockResolvedValue(undefined);
  attachCircuit.mockResolvedValue(undefined);
  setDeviceProp.mockResolvedValue(undefined);
  setNetworkTier.mockResolvedValue(undefined);
  getNetworkState.mockResolvedValue({
    tier: 'off',
    wifi: 'off',
    mqttConnected: false,
    blynkOnline: false,
    error: null,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useSimRunner — lifecycle', () => {
  it('run() compiles, loads, starts → status running', async () => {
    const { runner, wrapper } = withRunner();
    await runner.run('void setup(){} void loop(){}');
    await flushPromises();
    expect(loadHex).toHaveBeenCalledWith(':00000001FF');
    expect(start).toHaveBeenCalled();
    expect(runner.status.value).toBe('running');
    expect(runner.running.value).toBe(true);
    wrapper.unmount();
  });

  it('run() surfaces a friendly compile error and starts nothing', async () => {
    compileToHex.mockResolvedValue({
      hex: undefined,
      diagnostics: [{ message: "expected ';'", file: '', line: 1, severity: 'error' }],
    });
    const { runner, wrapper } = withRunner();
    await runner.run('bad');
    await flushPromises();
    expect(runner.status.value).toBe('error');
    expect(runner.message.value).toContain('chấm phẩy');
    expect(start).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('run() reports a thrown error (e.g. missing toolchain)', async () => {
    compileToHex.mockRejectedValue(new Error('toolchain missing'));
    const { runner, wrapper } = withRunner();
    await runner.run('x');
    await flushPromises();
    expect(runner.status.value).toBe('error');
    expect(runner.message.value).toContain('toolchain');
    wrapper.unmount();
  });

  it('run() is a no-op while already compiling (no double compile)', async () => {
    let resolveCompile: (v: { hex?: string; diagnostics: unknown[] }) => void = () => {};
    compileToHex.mockReturnValue(new Promise((r) => (resolveCompile = r)));
    const { runner, wrapper } = withRunner();
    const p1 = runner.run('a');
    const p2 = runner.run('a'); // guarded — compiling
    await p2;
    resolveCompile({ hex: ':00', diagnostics: [] });
    await p1;
    await flushPromises();
    expect(compileToHex).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('stop() during an in-flight compile abandons the run (no zombie start)', async () => {
    let resolveCompile: (v: { hex?: string; diagnostics: unknown[] }) => void = () => {};
    compileToHex.mockReturnValue(new Promise((r) => (resolveCompile = r)));
    const { runner, wrapper } = withRunner();
    const p = runner.run('x');
    await flushPromises(); // reach the compile await
    await runner.stop(); // user stops mid-compile → generation bumped
    resolveCompile({ hex: ':00', diagnostics: [] }); // compile finishes late
    await p;
    await flushPromises();
    expect(start).not.toHaveBeenCalled(); // run abandoned — never started the emulator
    expect(runner.status.value).toBe('idle');
    expect(runner.running.value).toBe(false);
    wrapper.unmount();
  });

  it('stops the sim worker on unmount (no worker left running)', async () => {
    const { runner, wrapper } = withRunner();
    await runner.run('x');
    await flushPromises();
    stop.mockClear();
    wrapper.unmount();
    expect(stop).toHaveBeenCalled();
  });

  it('poll maps getState → refs and idles when the sim reports stopped', async () => {
    const { runner, wrapper } = withRunner();
    await runner.run('x');
    await flushPromises();
    getState.mockResolvedValue({
      pins: { 13: 1, 7: 1 },
      pin13: true,
      ledToggles: 6,
      serial: 'hi',
      virtualTimeMs: 2000,
      running: true,
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(runner.ledOn.value).toBe(true);
    expect(runner.pins.value).toEqual({ 13: 1, 7: 1 }); // full per-pin map, not just pin 13
    expect(runner.serial.value).toBe('hi');
    expect(runner.ledToggles.value).toBe(6);
    getState.mockResolvedValue({
      pin13: false,
      ledToggles: 6,
      serial: 'hi',
      virtualTimeMs: 2100,
      running: false,
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(runner.status.value).toBe('idle');
    expect(runner.running.value).toBe(false);
    wrapper.unmount();
  });

  it('poll surfaces a firmware trap (halted) as an error, not a clean idle', async () => {
    const { runner, wrapper } = withRunner();
    await runner.run('x');
    await flushPromises();
    // The firmware hit an unimplemented instruction: running=false BUT halted=true with a reason.
    getState.mockResolvedValue({
      pin13: false,
      ledToggles: 0,
      serial: 'partial',
      virtualTimeMs: 50,
      running: false,
      halted: true,
      haltReason: 'unimplemented CPU instruction (LSAI @ pc 0x12c)',
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(runner.status.value).toBe('error'); // NOT 'idle' — a dead run must not look like a clean finish
    expect(runner.message.value).toContain('unimplemented CPU instruction');
    wrapper.unmount();
  });

  it('poll surfaces a worker error and stops polling', async () => {
    const { runner, wrapper } = withRunner();
    await runner.run('x');
    await flushPromises();
    getState.mockRejectedValue(new Error('worker died'));
    await vi.advanceTimersByTimeAsync(150);
    expect(runner.status.value).toBe('error');
    expect(runner.message.value).toContain('worker died');
    wrapper.unmount();
  });
});
